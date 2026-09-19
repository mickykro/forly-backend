#!/usr/bin/env bash
#
# vps-dev-bridge.sh — run ON THE VPS. Creates the container that lets n8n and
# GreenAPI reach the dev server running on a laptop.
#
#   n8n  ──► http://forly-dev-bridge:8787   (container-to-container, no auth)
#   web  ──► https://dev.srv1173890.hstgr.cloud/files/**  (Traefik, public)
#              └─ socat ─► 172.18.0.1:8788 ─► reverse tunnel ─► laptop:8787
#
# RUN IT AS A FILE, NEVER BY PASTING IT:
#     bash /root/vps-dev-bridge.sh
# Pasted into a login shell, `set -e` and the error paths below will close
# your session.
#
# Idempotent: safe to re-run after a reboot or a config change.
#
# ── TWO MODES ─────────────────────────────────────────────────────────────
# Default (no DEV_BASIC_AUTH_HTPASSWD): only /files/** is routed publicly —
#   what GreenAPI must fetch anonymously to deliver a rendered video. Every
#   other path has no public route at all and Traefik answers 404. n8n still
#   gets the whole API over the docker network. Nothing to remember, and the
#   public surface is static file serving.
#
# With DEV_BASIC_AUTH_HTPASSWD set: the whole host is routed publicly and
#   protected by basicAuth, except /files/**. Use this only if something off
#   the VPS needs the API — a phone, a colleague, an external webhook.
#
# The hostname is NOT a secret either way: Let's Encrypt publishes every
# certificate to Certificate Transparency logs, which bots scrape. Treat
# anything routed here as internet-facing.
#
# ── VALUES READ OFF THE RUNNING BOX, NOT ASSUMED ──────────────────────────
#   traefik container  root-traefik-1 (traefik:latest)
#   provider           docker, exposedbydefault=false → traefik.enable=true
#   entrypoints        web :80 (redirects to websecure), websecure :443
#   cert resolver      mytlschallenge, acme.tlschallenge=true (TLS-ALPN-01)
#   network            root_default, gateway 172.18.0.1
#   routers in use     forly, n8n
#
# Traefik answers the ACME challenge itself, so the certificate does not
# depend on the tunnel being up. Start order is free.

case "${0}" in
  -bash|bash|-sh|sh|-zsh|zsh)
    echo "!!"
    echo "!! This was PASTED into a shell rather than run as a file."
    echo "!! Save it and run:   bash /root/vps-dev-bridge.sh"
    echo "!! Continuing would enable 'set -e' in your login shell and any"
    echo "!! error below would disconnect you."
    echo "!!"
    ;;
esac

set -euo pipefail

NAME="${NAME:-forly-dev-bridge}"
NETWORK="${NETWORK:-root_default}"
HOST_PORT="${HOST_PORT:-8788}"
DEV_HOST="${DEV_HOST:-dev.srv1173890.hstgr.cloud}"
N8N_CONTAINER="${N8N_CONTAINER:-root-n8n-1}"
PROD_URL="${PROD_URL:-https://forly.srv1173890.hstgr.cloud/createPropertyPage}"

die() { echo "vps-dev-bridge: $*" >&2; exit 1; }

# ── mode ──────────────────────────────────────────────────────────────────
AUTH="${DEV_BASIC_AUTH_HTPASSWD:-}"
if [ -n "$AUTH" ]; then
  MODE="basicauth"
  ROUTERS="forlydev forlydev-public"
  case "$AUTH" in
    *'$$'*) die "DEV_BASIC_AUTH_HTPASSWD contains '\$\$'. Doubling the \$ is a
  docker-compose convention and is wrong for docker run — basicAuth would
  reject every password. Re-export the htpasswd output verbatim." ;;
    *:*) : ;;
    *) die "DEV_BASIC_AUTH_HTPASSWD is not 'user:hash' from htpasswd -nbB." ;;
  esac
else
  MODE="internal"
  ROUTERS="forlydev-public"
fi
echo "vps-dev-bridge: mode=$MODE"

# ── gateway ───────────────────────────────────────────────────────────────
GW="$(docker network inspect "$NETWORK" -f '{{(index .IPAM.Config 0).Gateway}}')"
[ -n "$GW" ] || die "could not read the gateway address for network $NETWORK"
echo "vps-dev-bridge: $NETWORK gateway is $GW"
echo "vps-dev-bridge: the laptop runs   BRIDGE_GW=$GW bash scripts/dev-tunnel.sh"

# ── router-name collision pre-flight ──────────────────────────────────────
# The one way this script can break production: Traefik takes duplicate router
# names last-writer-wins, so redefining an existing one silently steals its
# route. On this box `forly` serves forly.srv1173890.hstgr.cloud AND
# nadlan.call4li.com. Refuse rather than risk it.
for r in $ROUTERS; do
  owner=""
  for c in $(docker ps --format '{{.Names}}'); do
    [ "$c" = "$NAME" ] && continue
    if docker inspect "$c" -f '{{json .Config.Labels}}' 2>/dev/null \
         | tr ',' '\n' | grep -q "traefik\.http\.routers\.${r}\."; then
      owner="$c"; break
    fi
  done
  [ -z "$owner" ] || die "router '${r}' already belongs to container '${owner}'.
  Creating it here would hijack that route. Nothing was changed."
done
echo "vps-dev-bridge: router names free: $ROUTERS"

# ── production baseline ───────────────────────────────────────────────────
PROD_BEFORE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
  "$PROD_URL" -H 'Content-Type: application/json' -d '{}' || echo "000")
echo "vps-dev-bridge: production baseline forly=$PROD_BEFORE"

# ── create ────────────────────────────────────────────────────────────────
docker rm -f "$NAME" >/dev/null 2>&1 || true

# /files/** is the one path that must stay anonymous: GreenAPI fetches the
# rendered video from it and cannot present credentials. Put auth in front of
# it and video delivery fails silently while everything else looks fine.
LABELS=(
  -l traefik.enable=true
  -l "traefik.http.routers.forlydev-public.rule=Host(\`${DEV_HOST}\`) && PathPrefix(\`/files/\`)"
  -l traefik.http.routers.forlydev-public.priority=100
  -l traefik.http.routers.forlydev-public.entrypoints=web,websecure
  -l traefik.http.routers.forlydev-public.tls=true
  -l traefik.http.routers.forlydev-public.tls.certresolver=mytlschallenge
  -l traefik.http.routers.forlydev-public.service=forlydev
  -l traefik.http.services.forlydev.loadbalancer.server.port=8787
)
if [ "$MODE" = "basicauth" ]; then
  LABELS+=(
    -l "traefik.http.middlewares.forlydev-auth.basicauth.users=${AUTH}"
    -l "traefik.http.routers.forlydev.rule=Host(\`${DEV_HOST}\`)"
    -l traefik.http.routers.forlydev.priority=1
    -l traefik.http.routers.forlydev.entrypoints=web,websecure
    -l traefik.http.routers.forlydev.tls=true
    -l traefik.http.routers.forlydev.tls.certresolver=mytlschallenge
    -l traefik.http.routers.forlydev.middlewares=forlydev-auth
    -l traefik.http.routers.forlydev.service=forlydev
  )
fi

docker run -d --name "$NAME" --restart unless-stopped \
  --network "$NETWORK" "${LABELS[@]}" \
  alpine/socat \
  TCP-LISTEN:8787,fork,reuseaddr "TCP:${GW}:${HOST_PORT}"

sleep 2
docker ps --filter "name=$NAME" --format 'vps-dev-bridge: container STATUS: {{.Status}}'

# ── can n8n actually reach it? ────────────────────────────────────────────
# Docker resolves a container name only for containers sharing a network. In
# internal mode this IS the access path, so verify rather than assume it.
echo
if docker inspect "$N8N_CONTAINER" -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null \
     | tr ' ' '\n' | grep -qx "$NETWORK"; then
  echo "vps-dev-bridge: ✓ $N8N_CONTAINER is on $NETWORK — point n8n HTTP nodes at:"
  echo "                  http://${NAME}:8787/api/video-overlay"
else
  echo "vps-dev-bridge: ✗ $N8N_CONTAINER is NOT on $NETWORK (or does not exist)."
  docker inspect "$N8N_CONTAINER" -f '   its networks: {{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null \
    || echo "   container not found — set N8N_CONTAINER=<name> and re-run"
  if [ "$MODE" = "internal" ]; then
    echo "   In internal mode that is the ONLY way n8n can reach the dev server."
    echo "   Either attach it:  docker network connect $NETWORK $N8N_CONTAINER"
    echo "   or re-run with DEV_BASIC_AUTH_HTPASSWD set and use the public URL."
  fi
fi

# ── tunnel present? ───────────────────────────────────────────────────────
echo
if docker run --rm --network "$NETWORK" alpine/socat -T2 - "TCP:${NAME}:8787" </dev/null >/dev/null 2>&1; then
  echo "vps-dev-bridge: ✓ something is answering through the bridge"
else
  echo "vps-dev-bridge: - nothing behind the bridge yet (start the laptop tunnel)"
  echo "                  The TLS certificate is unaffected by this."
fi

# ── production post-check ─────────────────────────────────────────────────
echo
PROD_AFTER=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
  "$PROD_URL" -H 'Content-Type: application/json' -d '{}' || echo "000")
if [ "$PROD_AFTER" = "$PROD_BEFORE" ]; then
  echo "vps-dev-bridge: ✓ production unchanged (forly=$PROD_AFTER)"
else
  echo "vps-dev-bridge: ✗✗ PRODUCTION CHANGED: was $PROD_BEFORE, now $PROD_AFTER"
  echo "   Undo now:  docker rm -f $NAME"
fi
