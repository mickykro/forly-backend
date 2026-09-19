#!/usr/bin/env bash
#
# dev-tunnel.sh — publish the LOCAL dev server at a permanent public URL.
#
#   https://dev.srv1173890.hstgr.cloud  →  VPS Traefik
#                                       →  forly-dev-bridge (socat)
#                                       →  this reverse tunnel
#                                       →  localhost:8787   (your working tree)
#
# Replaces `npx cloudflared tunnel --url`, whose hostname was random and died
# after a day or two — which meant re-editing the n8n "Stitch And Overlay
# Titles" node every time, and left dead media URLs in Firestore. The hostname
# here never changes, so that node is configured once and left alone.
#
#   BRIDGE_GW=172.18.0.1 bash scripts/dev-tunnel.sh
#
# Get BRIDGE_GW once, on the VPS:
#   docker network inspect root_default -f '{{(index .IPAM.Config 0).Gateway}}'
#
# Runs in the foreground; ^C to stop. Pair it with `npm run local` in another
# terminal, and set BASE_URL / REMOTE_UPLOAD_BASE per server/package.json.
set -euo pipefail

VPS_HOST="${VPS_HOST:-31.97.216.242}"
VPS_USER="${VPS_USER:-root}"
TUNNEL_KEY="${TUNNEL_KEY:-$HOME/.ssh/forly_tunnel}"
LOCAL_PORT="${LOCAL_PORT:-8787}"
REMOTE_PORT="${REMOTE_PORT:-8788}"
PUBLIC_URL="${PUBLIC_URL:-https://dev.srv1173890.hstgr.cloud}"

die() { echo "dev-tunnel: $*" >&2; exit 1; }

# ── the security-critical check ───────────────────────────────────────────
# The tunnel must bind the VPS's DOCKER BRIDGE GATEWAY, never 0.0.0.0. The
# gateway is private, so only containers on root_default — i.e. the Traefik
# bridge — can reach the listener. Bind 0.0.0.0 and the dev server is published
# at http://<vps-ip>:8788 to the whole internet, around Traefik, around TLS,
# and around the basicAuth on dev.srv1173890.hstgr.cloud. That is a bypass of
# every control in front of this server, so it is a hard refusal, not a warning.
[ -n "${BRIDGE_GW:-}" ] || die "BRIDGE_GW is unset. On the VPS run:
    docker network inspect root_default -f '{{(index .IPAM.Config 0).Gateway}}'
  then re-run:  BRIDGE_GW=<that-address> bash scripts/dev-tunnel.sh"

case "$BRIDGE_GW" in
  0.0.0.0|"*"|::) die "BRIDGE_GW=$BRIDGE_GW would expose this server publicly. Use the docker bridge gateway." ;;
  10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) : ;;
  *) die "BRIDGE_GW=$BRIDGE_GW is not an RFC1918 address. Expected the docker bridge gateway (e.g. 172.18.0.1)." ;;
esac

# ── preflight ─────────────────────────────────────────────────────────────
command -v autossh >/dev/null || die "autossh not installed (brew install autossh / apt install autossh)"
[ -f "$TUNNEL_KEY" ] || die "no ssh key at $TUNNEL_KEY — see Part A of the setup notes"

if ! (exec 3<>"/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null; then
  echo "dev-tunnel: WARNING nothing is listening on 127.0.0.1:$LOCAL_PORT."
  echo "            The tunnel will come up and $PUBLIC_URL will return 502"
  echo "            until you start the server (npm run local)."
fi

echo "dev-tunnel: $PUBLIC_URL  →  ${BRIDGE_GW}:${REMOTE_PORT}  →  localhost:${LOCAL_PORT}"
echo "dev-tunnel: ^C to stop. Reconnects by itself across sleep and wifi drops."

# ExitOnForwardFailure: without it ssh connects happily while the forward fails,
# so the tunnel looks healthy and every request 502s. The usual cause is another
# machine already holding the port — worth failing loudly for.
exec autossh -M 0 -N \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=accept-new \
  -i "$TUNNEL_KEY" \
  -R "${BRIDGE_GW}:${REMOTE_PORT}:localhost:${LOCAL_PORT}" \
  "${VPS_USER}@${VPS_HOST}"
