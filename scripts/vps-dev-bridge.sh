#!/usr/bin/env bash
#
# vps-dev-bridge.sh — run ON THE VPS. Creates the container that lets Traefik
# route dev.srv1173890.hstgr.cloud at the reverse tunnel from a laptop.
#
#   Traefik ──► forly-dev-bridge (socat) ──► <gateway>:8788 ──► laptop:8787
#
# The tunnel terminates on the HOST, but Traefik only routes to containers on
# its own network, so something has to bridge the two. socat is that something.
#
#   bash scripts/vps-dev-bridge.sh
#
# Idempotent: re-run after a reboot or to pick up a new password.
#
# Values below were read off the running box, not assumed:
#   traefik container  root-traefik-1 (traefik:latest)
#   provider           docker, exposedbydefault=false → traefik.enable=true required
#   entrypoints        web :80 (redirects to websecure), websecure :443
#   cert resolver      mytlschallenge, acme.tlschallenge=true  (TLS-ALPN-01)
#   network            root_default, gateway 172.18.0.1
#   routers in use     forly, n8n
#
# The cert is obtained by Traefik over TLS-ALPN-01 on :443 and does NOT depend
# on anything being behind the router, so the tunnel does not have to be up
# first. Start order is free.
set -euo pipefail

NAME="${NAME:-forly-dev-bridge}"
NETWORK="${NETWORK:-root_default}"
HOST_PORT="${HOST_PORT:-8788}"
DEV_HOST="${DEV_HOST:-dev.srv1173890.hstgr.cloud}"
# Routers this script defines. Checked against what Traefik already serves
# before anything is created — a duplicate name would silently take over an
# existing route, and on this box that means forly.srv1173890.hstgr.cloud and
# nadlan.call4li.com.
ROUTERS="forlydev forlydev-public"

die() { echo "vps-dev-bridge: $*" >&2; exit 1; }

# htpasswd line guarding everything except /files/. Generate with:
#   htpasswd -nbB dev '<password>'
# Pass it through VERBATIM. The $ characters in a bcrypt hash need doubling in
# a docker-compose.yml, because compose does its own interpolation — but this
# is `docker run` with the value coming from a quoted shell variable, so the
# shell expands it once and Docker never looks at it again. Doubling here
# CORRUPTS the hash and every login silently fails.
[ -n "${DEV_BASIC_AUTH_HTPASSWD:-}" ] || die "DEV_BASIC_AUTH_HTPASSWD is unset.
  Generate it with:  htpasswd -nbB dev '<password>'
  and export it exactly as printed — do not escape or double the \$ signs."

case "$DEV_BASIC_AUTH_HTPASSWD" in
  *'$$'*) die "DEV_BASIC_AUTH_HTPASSWD contains '\$\$'. That doubling is a
  docker-compose convention and is wrong here — basicAuth would reject every
  password. Re-export the htpasswd output verbatim." ;;
  *:*) : ;;
  *) die "DEV_BASIC_AUTH_HTPASSWD does not look like 'user:hash' output from htpasswd -nbB." ;;
esac

GW="$(docker network inspect "$NETWORK" -f '{{(index .IPAM.Config 0).Gateway}}')"
[ -n "$GW" ] || die "could not read the gateway address for network $NETWORK"

# ── router-name collision pre-flight ──────────────────────────────────────
# The one way this script can break production. Traefik resolves duplicate
# router names by last-writer-wins, so creating a router that already exists
# silently redirects whatever it was serving. Refuse rather than risk it.
# Our own container is excluded so re-running this script stays idempotent.
for r in $ROUTERS; do
  owner=""
  for c in $(docker ps --format '{{.Names}}'); do
    [ "$c" = "$NAME" ] && continue
    if docker inspect "$c" -f '{{json .Config.Labels}}' 2>/dev/null \
         | tr ',' '\n' | grep -q "traefik\.http\.routers\.${r}\."; then
      owner="$c"; break
    fi
  done
  [ -z "$owner" ] || die "router '${r}' is already defined by container '${owner}'.
  Creating it here would hijack that route. Rename via the ROUTERS variable
  and the labels below, or remove the other definition first."
done
echo "vps-dev-bridge: router names free: $ROUTERS"

# Baseline: production must be answering BEFORE we add anything, so that if it
# stops afterwards we know this script is why.
PROD_BEFORE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
  https://forly.srv1173890.hstgr.cloud/createPropertyPage \
  -H 'Content-Type: application/json' -d '{}' || echo "000")
echo "vps-dev-bridge: production baseline forly=$PROD_BEFORE"
echo "vps-dev-bridge: network $NETWORK gateway is $GW"
echo "vps-dev-bridge: the laptop must run  BRIDGE_GW=$GW bash scripts/dev-tunnel.sh"

docker rm -f "$NAME" 2>/dev/null || true

# Two routers over one service. /files/ MUST stay anonymous: it is what
# GreenAPI fetches to deliver a rendered video, and it has no way to present
# credentials — put basicAuth in front of it and video delivery fails silently
# while everything else looks fine. Higher priority wins in Traefik, so the
# public rule is evaluated before the catch-all.
#
# Router names are deliberately distinct from production's `forly` router. A
# collision would silently steal the route for forly.srv1173890.hstgr.cloud
# and nadlan.call4li.com — the one way this whole setup can break production.
docker run -d --name "$NAME" --restart unless-stopped \
  --network "$NETWORK" \
  -l traefik.enable=true \
  -l "traefik.http.middlewares.forlydev-auth.basicauth.users=${DEV_BASIC_AUTH_HTPASSWD}" \
  -l "traefik.http.routers.forlydev-public.rule=Host(\`${DEV_HOST}\`) && PathPrefix(\`/files/\`)" \
  -l traefik.http.routers.forlydev-public.priority=100 \
  -l traefik.http.routers.forlydev-public.entrypoints=web,websecure \
  -l traefik.http.routers.forlydev-public.tls=true \
  -l traefik.http.routers.forlydev-public.tls.certresolver=mytlschallenge \
  -l traefik.http.routers.forlydev-public.service=forlydev \
  -l "traefik.http.routers.forlydev.rule=Host(\`${DEV_HOST}\`)" \
  -l traefik.http.routers.forlydev.priority=1 \
  -l traefik.http.routers.forlydev.entrypoints=web,websecure \
  -l traefik.http.routers.forlydev.tls=true \
  -l traefik.http.routers.forlydev.tls.certresolver=mytlschallenge \
  -l traefik.http.routers.forlydev.middlewares=forlydev-auth \
  -l traefik.http.routers.forlydev.service=forlydev \
  -l traefik.http.services.forlydev.loadbalancer.server.port=8787 \
  alpine/socat \
  TCP-LISTEN:8787,fork,reuseaddr "TCP:${GW}:${HOST_PORT}"

sleep 2
docker ps --filter "name=$NAME" --format 'STATUS: {{.Status}}'

echo
echo "vps-dev-bridge: checking the tunnel is actually behind it..."
if docker run --rm --network "$NETWORK" alpine/socat -T2 - "TCP:${NAME}:8787" </dev/null >/dev/null 2>&1; then
  echo "  ✓ bridge reachable — open https://${DEV_HOST}"
else
  echo "  - nothing answering through the bridge yet. Expected if the laptop"
  echo "    tunnel is not running; start scripts/dev-tunnel.sh and re-check."
  echo "    The TLS certificate is unaffected: Traefik answers the ACME"
  echo "    challenge itself over TLS-ALPN-01, independent of this backend."
fi

# ── production post-check ─────────────────────────────────────────────────
# The whole point of the pre-flight above. If production stopped answering
# between the baseline and here, this container is the cause — say so loudly
# and name the command that reverses it.
echo
PROD_AFTER=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
  https://forly.srv1173890.hstgr.cloud/createPropertyPage \
  -H 'Content-Type: application/json' -d '{}' || echo "000")
if [ "$PROD_AFTER" = "$PROD_BEFORE" ]; then
  echo "vps-dev-bridge: ✓ production unchanged (forly=$PROD_AFTER)"
else
  echo "vps-dev-bridge: ✗✗ PRODUCTION CHANGED: was $PROD_BEFORE, now $PROD_AFTER"
  echo "   Undo immediately:  docker rm -f $NAME"
fi
docker ps --filter 'name=forly-intake' --format '  {{.Names}}  {{.Status}}'
