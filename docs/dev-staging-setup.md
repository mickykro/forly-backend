# Setting up the dev tunnel and staging server

One-time setup for the two permanent hosts:

| Host | Serves | Up when |
|---|---|---|
| `https://dev.srv1173890.hstgr.cloud` | the code running on your laptop, live | your laptop is on and the tunnel is running |
| `https://staging.srv1173890.hstgr.cloud` | a container built from the `staging` branch | always |

Work through the steps in order — later ones depend on earlier ones. Budget
about 30 minutes. Everything here is one-time except step 7, which is how you
start work each day.

Throughout: `31.97.216.242` is the VPS, and the repo on it lives at
`/root/forly-backend`.

---

## Before you start

No DNS work is needed. `*.srv1173890.hstgr.cloud` is already a wildcard onto
the VPS — you can confirm from anywhere:

```bash
getent ahostsv4 dev.srv1173890.hstgr.cloud     | head -1
getent ahostsv4 staging.srv1173890.hstgr.cloud | head -1
```

Both must print `31.97.216.242`. If they don't, stop — nothing below will work.

> Ask for the v4 record specifically. The host also has an AAAA record
> (`2a02:4780:41:89aa::1`), so a plain `getent hosts` or `ping` may show you
> the IPv6 address and look like a mismatch when nothing is wrong.

You also need the branch available on the VPS, since the scripts live in it:

```bash
ssh root@31.97.216.242
cd /root/forly-backend
git fetch origin claude/stable-global-dev-server-222vb4
git checkout claude/stable-global-dev-server-222vb4
ls scripts/vps-dev-bridge.sh    # must exist
```

> Once the branch is merged to `main`, switch the VPS checkout back:
> `git checkout -B main origin/main`.

---

## Step 1 — Let the VPS accept a reverse tunnel

The tunnel needs to bind an address other than loopback so the Traefik bridge
container can reach it. That is off by default.

**Open a second SSH session first and leave it connected.** If you get the
config wrong, that session is how you fix it instead of being locked out.

```bash
ssh root@31.97.216.242

cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak.$(date +%F)

cat >> /etc/ssh/sshd_config <<'EOF'

# ── forly dev tunnel ──────────────────────────────────────────────────────
# Let the client choose the bind address for a remote forward, so the tunnel
# can be pinned to the private docker bridge gateway instead of every
# interface. "clientspecified", NOT "yes" — see scripts/dev-tunnel.sh.
GatewayPorts clientspecified
# Reap dead tunnels, or a stale listener keeps port 8788 and the next
# reconnect fails with "address already in use".
ClientAliveInterval 30
ClientAliveCountMax 3
EOF
```

Now validate **before** reloading:

```bash
sshd -t && echo "config OK"
```

If that prints anything other than `config OK`, fix it (or restore
`/etc/ssh/sshd_config.bak.*`) and do not reload. Once it passes:

```bash
# The unit is called `ssh` on Debian/Ubuntu and `sshd` on RHEL/CentOS. Try
# both rather than guessing — a failed reload leaves the file edited but the
# running daemon still on the OLD config, which looks like success until the
# tunnel fails to bind much later.
for u in ssh sshd; do
  systemctl reload "$u" 2>/dev/null && { echo "reloaded $u"; break; }
done
```

That must print `reloaded ssh` (or `reloaded sshd`). If it prints nothing, the
reload did not happen — find the right unit with
`systemctl list-units --type=service | grep -i ssh` before continuing.

In your *other* session, confirm you can still open a new connection:

```bash
ssh -o BatchMode=yes root@31.97.216.242 true && echo "still reachable"
```

---

## Step 2 — Note the docker bridge gateway

```bash
ssh root@31.97.216.242 \
  "docker network inspect root_default -f '{{(index .IPAM.Config 0).Gateway}}'"
```

Write down what it prints — something like `172.18.0.1`. It is referred to
below as `<BRIDGE_GW>`. It is a private address, which is the entire point:
the tunnel binds only there, so the dev server is reachable through Traefik
and nowhere else.

---

## Step 3 — Create the tunnel key (on your laptop)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/forly_tunnel -N "" -C "forly dev tunnel"
ssh-copy-id -i ~/.ssh/forly_tunnel.pub root@31.97.216.242
```

Check it works without a password:

```bash
ssh -i ~/.ssh/forly_tunnel -o BatchMode=yes root@31.97.216.242 true && echo "key OK"
```

Install `autossh` if you don't have it — it is what reconnects the tunnel
after sleep or a wifi drop:

```bash
brew install autossh        # macOS
sudo apt install autossh    # Debian/Ubuntu
```

---

## Step 4 — Create `staging.env` on the VPS

Staging shares production's data and credentials for now (that is Phase 1 by
design; issues #46 and #47 separate them). Only four values differ, so derive
the file from `deploy.env` rather than retyping secrets:

```bash
ssh root@31.97.216.242
cd /root/forly-backend

# Start from production's env, minus the four keys we override.
grep -vE '^(BASE_URL|PAGE_BASE_URL|ALLOW_INFRA_PAGE_BASE|REMOTE_UPLOAD_BASE)=' \
  deploy.env > staging.env

cat >> staging.env <<'EOF'

# ── staging overrides ─────────────────────────────────────────────────────
BASE_URL=https://staging.srv1173890.hstgr.cloud
PAGE_BASE_URL=https://staging.srv1173890.hstgr.cloud
# Without this, PAGE_BASE_URL above is silently rewritten to
# https://nadlan.call4li.com, because *.hstgr.cloud is on the infra-host
# blocklist that keeps tunnel hostnames out of buyer-visible links.
ALLOW_INFRA_PAGE_BASE=1
EOF

chmod 600 staging.env
```

**Do not add `REMOTE_UPLOAD_BASE` to this file.** Staging is always on, so the
URLs it stamps are already durable. Pointing it at itself is refused at boot,
and pointing it at production would put staging's test media into production's
volume.

Sanity-check that the secret staging will use matches production's — the dev
upload relay depends on it:

```bash
grep -c NADLAN_JWT_SECRET staging.env     # must print 1
diff <(grep NADLAN_JWT_SECRET deploy.env) <(grep NADLAN_JWT_SECRET staging.env) \
  && echo "secrets match"
```

---

## Step 5 — Deploy staging

The workflow runs on pushes to a branch called `staging`. Create it from the
feature branch (later, from `main`):

```bash
# on your laptop, in the repo
git fetch origin
git checkout -B staging origin/claude/stable-global-dev-server-222vb4
git push -u origin staging
```

Watch it in the repo's **Actions** tab — "Deploy server to staging". It does
three things, and the third is the one that matters: it asserts production
still answers after the deploy, so a container or Traefik router name collision
fails the job instead of silently stealing production's route.

No GitHub secret needs adding. `VPS_HOST`, `VPS_USER` and `VPS_SSH_KEY` already
exist from the production workflow, and the dev password in step 6 is used only
on the VPS, never in CI.

When it's green:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://staging.srv1173890.hstgr.cloud/createPropertyPage \
  -H 'Content-Type: application/json' -d '{}'
```

`400` is success — the request reached the app and was rejected as empty, which
is what a working deploy looks like. `404` means Traefik has no route yet;
`502` means the container is not up.

---

## Step 6 — Start the dev bridge on the VPS

This is the container Traefik routes `dev.` at.

First pick a password and turn it into an htpasswd line:

```bash
htpasswd -nbB dev 'choose-a-password-here'
```

It prints something like:

```
dev:$2y$05$Ft8N1kQ2mOq...
```

**Copy that line verbatim.** Do not escape or double the `$` signs — that
doubling is a docker-compose convention and is wrong here; it produces a hash
that rejects every password. The script refuses input containing `$$` for
exactly this reason.

```bash
ssh root@31.97.216.242
cd /root/forly-backend

export DEV_BASIC_AUTH_HTPASSWD='dev:$2y$05$Ft8N1kQ2mOq...'   # single quotes
bash scripts/vps-dev-bridge.sh
```

Single quotes matter — double quotes let your shell mangle the `$` sequences.

Expected output ends with `STATUS: Up ...`, the gateway address from step 2,
and a note about whether anything is answering through the bridge. It will say
nothing is — correct at this point, since the tunnel isn't running yet.

---

## Step 7 — Configure and run the laptop side

Create `server/.env` (gitignored, never committed):

```bash
cd server
cat >> .env <<'EOF'

# ── dev tunnel ────────────────────────────────────────────────────────────
BASE_URL=https://dev.srv1173890.hstgr.cloud
PAGE_BASE_URL=https://staging.srv1173890.hstgr.cloud
ALLOW_INFRA_PAGE_BASE=1

# Media built here is stored on staging, not on this laptop. Without it, a
# page you build carries https://dev.… URLs that 502 the moment you close the
# lid — which is how the old tunnels left dead images on live pages.
REMOTE_UPLOAD_BASE=https://staging.srv1173890.hstgr.cloud
EOF
```

`NADLAN_JWT_SECRET` must also be in this file and must equal the value in
`deploy.env`/`staging.env`. Copy it from the VPS:

```bash
ssh root@31.97.216.242 'grep NADLAN_JWT_SECRET /root/forly-backend/staging.env'
```

Add it to `server/.env` if it isn't there already. Without a matching secret
the relay disables itself — it says so on boot rather than failing loudly, so
it is easy to miss.

> The loader only sets variables that aren't already in the environment, so a
> shell `export` beats the file. Handy for one-off overrides, confusing if you
> forget you did it.

**Now start both halves, in two terminals:**

```bash
# terminal 1 — the tunnel (leave running)
BRIDGE_GW=<BRIDGE_GW> bash scripts/dev-tunnel.sh

# terminal 2 — the server
cd server && npm run local
```

Terminal 2 should print, among other lines:

```
Forly server on https://dev.srv1173890.hstgr.cloud (port 8787)
  pages served: https://staging.srv1173890.hstgr.cloud/p/{id}
```

If `pages served:` says `nadlan.call4li.com`, `ALLOW_INFRA_PAGE_BASE=1` is not
being read. If a `WARNING` mentions `REMOTE_UPLOAD_BASE`, the secret doesn't
match — fix it before building any pages, or you will write dead URLs.

---

## Step 8 — Point n8n at it, once

In **WW1 Walkthrough V2** → **Stitch And Overlay Titles**:

- URL → `https://dev.srv1173890.hstgr.cloud/api/video-overlay`
- Authentication → Basic Auth → user `dev`, and the password from step 6

This is the last time that node needs editing. The hostname is permanent, so
there is no longer anything to put back when you finish for the day. Use
`staging.` instead of `dev.` when you want runs to work with your laptop off.

---

## Step 9 — Verify

Run these in order. Each one catches a specific failure.

**1. The public media path is NOT behind basicAuth.** GreenAPI fetches rendered
videos from `/files/` and cannot present credentials, so a `401` here means
video delivery fails silently while everything else looks fine.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://dev.srv1173890.hstgr.cloud/files/
```

Anything except `401` is fine (`403`/`404` are normal for a bare directory).

**2. Everything else IS behind basicAuth.**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://dev.srv1173890.hstgr.cloud/create.html
# → 401
curl -s -o /dev/null -w '%{http_code}\n' -u dev:'your-password' \
  https://dev.srv1173890.hstgr.cloud/create.html
# → 200
```

**3. The tunnel is not published to the internet.** Run this from your laptop
or anywhere that is not the VPS:

```bash
curl --max-time 5 http://31.97.216.242:8788/ ; echo "exit=$?"
```

It **must** fail to connect (`exit=7` or `exit=28`). If it returns a page, the
tunnel bound a public interface and every control above is bypassable — stop
and re-check `BRIDGE_GW`.

**4. It reconnects.** Kill the ssh process; `autossh` should re-establish it
within ~30s, and check 1 should pass again.

**5. Closing the laptop is graceful.** Stop the server; `dev.` should return
`502` rather than hanging.

**6. The one that actually matters.** Build a page end-to-end through n8n
against `dev.`, then check what got stored:

```bash
cd server && node ../scripts/report-stale-media.local.js
```

Then inspect the new `property_pages` document. `hero.video_url`,
`hero.poster_url` and every `gallery.images[].url` must carry
**`staging.srv1173890.hstgr.cloud`** — not `dev.`. Now close your laptop and
open the page on staging: video and all images must still render. That is the
whole point of the exercise.

---

## Daily use, after setup

```bash
# terminal 1
BRIDGE_GW=<BRIDGE_GW> bash scripts/dev-tunnel.sh
# terminal 2
cd server && npm run local
```

Nothing else. The URLs never change.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `dev.` returns 502 | server or tunnel not running | start both (step 7) |
| `dev.` returns 404 | bridge container not running | re-run step 6 |
| Browser warns about the certificate | Traefik tried to issue it while nothing was behind the route | start the tunnel, then `docker restart` the Traefik container so it retries |
| basicAuth rejects the right password | `$` signs doubled in the htpasswd line | re-run step 6 with the output verbatim |
| Tunnel exits with "remote port forwarding failed" | stale listener, or another machine holds it | find it with `ssh root@31.97.216.242 "ss -lptn 'sport = :8788'"`, kill the owning `sshd` pid, then restart |
| Boot warns about `REMOTE_UPLOAD_BASE` | `NADLAN_JWT_SECRET` differs from staging's | copy it from `staging.env` (step 7) |
| `pages served:` shows `nadlan.call4li.com` | `ALLOW_INFRA_PAGE_BASE` not set | check `server/.env`, and that no shell `export` is overriding it |
| Uploads 401 through the relay | secret mismatch between the two instances | same fix as above |

## Undoing it

```bash
# VPS
docker rm -f forly-dev-bridge
docker rm -f forly-intake-staging          # optional
cp /etc/ssh/sshd_config.bak.* /etc/ssh/sshd_config && sshd -t && \
  for u in ssh sshd; do systemctl reload "$u" 2>/dev/null && break; done
```

Production's container, labels and `deploy.env` are never touched by any of
this. Keep `forly-staging-uploads` unless you are certain no live page
references media stored there.
