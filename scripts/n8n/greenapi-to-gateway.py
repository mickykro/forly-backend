#!/usr/bin/env python3
"""
Swap the Green API nodes in n8n workflows for HTTP Request nodes that call
Forly's provider-neutral WhatsApp endpoints (server/routes/whatsapp-gateway.js):

  sendMessage / sendFileByUrl / sendInteractiveButtons → POST {base}/api/whatsapp/send
  getChatHistory                                        → POST {base}/api/whatsapp/history

Only those nodes change. Each keeps its id, name, position and connections, and
its chatId / message / file / button values are copied verbatim (n8n
expressions included). Everything else in the workflow — other nodes, their
credentials, settings — is sent back exactly as n8n returned it. That is why
this goes through n8n's REST API (full JSON, credentials included) and not the
MCP connector (which omits credentials).

Runs on the n8n host with Python 3 and nothing else. Dry run by default.

  export N8N_API_KEY=...            # n8n → Settings → n8n API → Create an API key
  python3 greenapi-to-gateway.py --n8n https://n8n.srv1173890.hstgr.cloud \\
      --base http://forly-intake-staging:8787 WORKFLOW_ID [WORKFLOW_ID ...]
  # check the printed plan, then add --apply

  # point already-migrated workflows at another server (staging → production):
  python3 greenapi-to-gateway.py --n8n ... --rebase http://forly-intake:8787 --apply ID ...

  # undo one workflow from its backup:
  python3 greenapi-to-gateway.py --n8n ... --restore n8n-backups/ID-TIMESTAMP.json --apply

Auth for the new nodes is copied from an existing node that already calls the
Forly server with the x-forly-secret header credential (default: Business
Handler v6 → "Forly Property Intake"; change with --auth-from ID:NODE_NAME).
"""

import argparse
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

GREEN_TYPE = "n8n-nodes-greenapi.greenapi"
GATEWAY_PATHS = ("/api/whatsapp/send", "/api/whatsapp/history")
# Keys the n8n public API accepts in `settings`; used only if n8n rejects the
# workflow's own settings object (and only with --allow-drop-settings).
SETTINGS_ALLOWED = {
    "saveExecutionProgress", "saveManualExecutions", "saveDataErrorExecution",
    "saveDataSuccessExecution", "executionTimeout", "errorWorkflow", "timezone",
    "executionOrder", "callerPolicy", "callerIds", "timeSavedPerExecution", "availableInMCP",
}
# Node-level fields carried over from the Green node to its replacement.
KEEP_FIELDS = ("id", "name", "position", "disabled", "notes", "notesInFlow", "onError",
               "alwaysOutputData", "retryOnFail", "maxTries", "waitBetweenTries",
               "executeOnce", "continueOnFail")


class N8n:
    def __init__(self, base, key):
        self.base = base.rstrip("/")
        self.key = key

    def call(self, method, path, body=None):
        req = urllib.request.Request(
            f"{self.base}/api/v1{path}", method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"X-N8N-API-KEY": self.key, "Accept": "application/json",
                     **({"Content-Type": "application/json"} if body is not None else {})})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"{method} {path} → {e.code}: {e.read().decode(errors='replace')[:400]}")


def operation_of(node):
    p = node.get("parameters", {})
    op = p.get("operation") or "sendMessage"
    return op


def body_params(pairs):
    return {"parameters": [{"name": k, "value": v} for k, v in pairs if v not in (None, "")]}


def buttons_json(raw):
    """Green node's fixedCollection {buttonUrl|buttonCopy|buttonCall: [...]} → JSON string."""
    out = []
    for key, kind, field in (("buttonUrl", "url", "url"), ("buttonCopy", "copy", "copyCode"),
                             ("buttonCall", "call", "phoneNumber")):
        for b in (raw or {}).get(key, []) or []:
            out.append({"type": kind, "buttonText": b.get("buttonText", ""), field: b.get(field, "")})
    if any(isinstance(v, str) and v.startswith("=") for b in out for v in b.values()):
        raise ValueError("button values are expressions; migrate this node by hand")
    return json.dumps(out, ensure_ascii=False)


def replacement(node, base, auth):
    """The HTTP Request node that stands in for one Green API node."""
    p = node.get("parameters", {})
    op = operation_of(node)
    to = p.get("chatId", "")
    quoted = p.get("quotedMessageId", "")
    if op == "sendMessage":
        path, pairs = "/api/whatsapp/send", [("to", to), ("text", p.get("message", "")), ("quoted_id", quoted)]
    elif op == "sendFileByUrl":
        path, pairs = "/api/whatsapp/send", [("to", to), ("file_url", p.get("urlFile", "")),
                                             ("file_name", p.get("fileName", "")), ("caption", p.get("caption", "")),
                                             ("quoted_id", quoted)]
    elif op == "sendInteractiveButtons":
        path, pairs = "/api/whatsapp/send", [("to", to), ("header", p.get("header", "")), ("text", p.get("body", "")),
                                             ("footer", p.get("footer", "")), ("buttons", buttons_json(p.get("buttons"))),
                                             ("quoted_id", quoted)]
    elif op == "getChatHistory":
        path, pairs = "/api/whatsapp/history", [("to", to), ("count", p.get("count", ""))]
    else:
        raise ValueError(f"operation {op!r} has no gateway equivalent; migrate this node by hand")
    new = {k: node[k] for k in KEEP_FIELDS if k in node}
    new.update({
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "parameters": {
            "method": "POST",
            "url": base.rstrip("/") + path,
            "authentication": "genericCredentialType",
            "genericAuthType": "httpHeaderAuth",
            "sendBody": True,
            "contentType": "json",
            "specifyBody": "keypair",
            "bodyParameters": body_params(pairs),
            "options": {"timeout": 30000},
        },
        "credentials": auth,
    })
    return new, op, path


def find_auth(n8n, spec):
    wf_id, node_name = spec.split(":", 1)
    wf = n8n.call("GET", f"/workflows/{wf_id}")
    for n in wf["nodes"]:
        if n["name"] == node_name:
            creds = n.get("credentials") or {}
            if "httpHeaderAuth" not in creds:
                raise SystemExit(f"--auth-from node {node_name!r} has no httpHeaderAuth credential: {list(creds)}")
            return {"httpHeaderAuth": creds["httpHeaderAuth"]}
    raise SystemExit(f"--auth-from: no node {node_name!r} in workflow {wf_id}")


def put_workflow(n8n, wf, allow_drop):
    body = {"name": wf["name"], "nodes": wf["nodes"], "connections": wf["connections"],
            "settings": wf.get("settings") or {}}
    if wf.get("staticData") is not None:
        body["staticData"] = wf["staticData"]
    try:
        return n8n.call("PUT", f"/workflows/{wf['id']}", body)
    except RuntimeError as e:
        if "settings" not in str(e):
            raise
        dropped = sorted(set(body["settings"]) - SETTINGS_ALLOWED)
        if not allow_drop:
            raise SystemExit(f"n8n refused the workflow settings ({e}). Re-run with --allow-drop-settings "
                             f"to send it without these keys: {dropped}")
        body["settings"] = {k: v for k, v in body["settings"].items() if k in SETTINGS_ALLOWED}
        print(f"  settings: dropped {dropped}")
        return n8n.call("PUT", f"/workflows/{wf['id']}", body)


def save_backup(wf, folder):
    os.makedirs(folder, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    path = os.path.join(folder, f"{wf['id']}-{stamp}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(wf, f, ensure_ascii=False, indent=1)
    return path


def publish(n8n, wf_id, was_active):
    if was_active:
        n8n.call("POST", f"/workflows/{wf_id}/activate")
    after = n8n.call("GET", f"/workflows/{wf_id}")
    print(f"  active: {after.get('active')}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n8n", required=True, help="n8n base URL, e.g. https://n8n.example.com")
    ap.add_argument("--base", help="Forly server base as n8n reaches it, e.g. http://forly-intake:8787")
    ap.add_argument("--rebase", help="re-point already-migrated nodes to this server base")
    ap.add_argument("--restore", help="PUT this backup file back")
    ap.add_argument("--auth-from", default="lQwn7eYSuIxAZkJB:Forly Property Intake",
                    help="WORKFLOW_ID:NODE_NAME whose x-forly-secret credential the new nodes reuse")
    ap.add_argument("--backup-dir", default="n8n-backups")
    ap.add_argument("--apply", action="store_true", help="write to n8n (default: dry run)")
    ap.add_argument("--allow-drop-settings", action="store_true")
    ap.add_argument("ids", nargs="*")
    a = ap.parse_args()
    key = os.environ.get("N8N_API_KEY", "").strip()
    if not key:
        raise SystemExit("set N8N_API_KEY")
    n8n = N8n(a.n8n, key)

    if a.restore:
        wf = json.load(open(a.restore, encoding="utf-8"))
        print(f"restore {wf['id']} {wf['name']!r} from {a.restore}")
        if a.apply:
            put_workflow(n8n, wf, a.allow_drop_settings)
            publish(n8n, wf["id"], wf.get("active"))
        else:
            print("  dry run — add --apply")
        return

    if not a.ids or not (a.base or a.rebase):
        raise SystemExit("give workflow ids and --base (or --rebase)")
    auth = None if a.rebase else find_auth(n8n, a.auth_from)

    for wf_id in a.ids:
        wf = n8n.call("GET", f"/workflows/{wf_id}")
        print(f"\n{wf_id}  {wf['name']!r}  active={wf.get('active')}")
        changed = 0
        for i, node in enumerate(wf["nodes"]):
            if a.rebase:
                url = node.get("parameters", {}).get("url", "")
                hit = next((p for p in GATEWAY_PATHS if node["type"] == "n8n-nodes-base.httpRequest" and url.endswith(p)), None)
                if hit:
                    node["parameters"]["url"] = a.rebase.rstrip("/") + hit
                    print(f"  {node['name']!r}: {url} → {node['parameters']['url']}")
                    changed += 1
                continue
            if node["type"] != GREEN_TYPE:
                continue
            try:
                new, op, path = replacement(node, a.base, auth)
            except ValueError as e:
                print(f"  SKIP {node['name']!r}: {e}")
                continue
            wf["nodes"][i] = new
            fields = ", ".join(x["name"] for x in new["parameters"]["bodyParameters"]["parameters"])
            print(f"  {node['name']!r}: {op} → POST {path} ({fields})")
            changed += 1
        if not changed:
            print("  nothing to change")
            continue
        if not a.apply:
            print(f"  {changed} node(s) would change — dry run, add --apply")
            continue
        backup = save_backup(n8n.call("GET", f"/workflows/{wf_id}"), a.backup_dir)
        print(f"  backup: {backup}")
        put_workflow(n8n, wf, a.allow_drop_settings)
        publish(n8n, wf_id, wf.get("active"))
        print(f"  updated {changed} node(s)")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        sys.exit(f"error: {e}")
