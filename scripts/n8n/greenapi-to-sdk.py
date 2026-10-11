#!/usr/bin/env python3
"""
Turn an n8n workflow (the JSON the n8n MCP connector's get_workflow_details
returns) into n8n Workflow SDK code for its update_workflow tool, with every
Green API node swapped for an HTTP Request node that calls Forly's WhatsApp
gateway (server/routes/whatsapp-gateway.js). Every other node, parameter and
connection is carried over as-is.

The connector never returns credentials, so the new HTTP nodes carry none:
the gateway accepts direct calls from inside the Docker network
(n8n → http://forly-intake[-staging]:8787) without the x-forly-secret.

  python3 greenapi-to-sdk.py details.json --base http://forly-intake-staging:8787 \\
      [--source active|draft] > workflow.sdk.js

--source active (default) converts the published version — what runs in
production — so unpublished draft edits are not published by accident.
"""

import argparse
import json
import re
import sys

GREEN_TYPE = "n8n-nodes-greenapi.greenapi"
TRIGGER_TYPES = re.compile(r"(Trigger|\.webhook|\.formTrigger|\.chatTrigger)$")
SUBNODE_KINDS = {  # connection type → (SDK factory, key under config.subnodes, many?)
    "ai_languageModel": ("languageModel", "model", False),
    "ai_outputParser": ("outputParser", "outputParser", False),
    "ai_memory": ("memory", "memory", False),
    "ai_tool": ("tool", "tools", True),
    "ai_embedding": ("embedding", "embedding", False),
    "ai_document": ("documentLoader", "documentLoader", False),
    "ai_textSplitter": ("textSplitter", "textSplitter", False),
    "ai_retriever": ("retriever", "retriever", False),
    "ai_vectorStore": ("vectorStore", "vectorStore", False),
}
CONFIG_KEYS = ("disabled", "onError", "alwaysOutputData", "executeOnce", "retryOnFail",
               "maxTries", "waitBetweenTries", "notes", "notesInFlow", "webhookId")


def buttons_json(raw):
    out = []
    for key, kind, field in (("buttonUrl", "url", "url"), ("buttonCopy", "copy", "copyCode"),
                             ("buttonCall", "call", "phoneNumber")):
        for b in (raw or {}).get(key, []) or []:
            out.append({"type": kind, "buttonText": b.get("buttonText", ""), field: b.get(field, "")})
    if any(isinstance(v, str) and v.startswith("=") for b in out for v in b.values()):
        raise ValueError("button values are expressions; migrate this node by hand")
    return json.dumps(out, ensure_ascii=False)


def gateway_node(node, base):
    """The HTTP Request node that stands in for one Green API node."""
    p = node.get("parameters", {})
    op = p.get("operation") or "sendMessage"
    to, quoted = p.get("chatId", ""), p.get("quotedMessageId", "")
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
        raise ValueError(f"operation {op!r} has no gateway equivalent")
    new = dict(node)
    new["type"] = "n8n-nodes-base.httpRequest"
    new["typeVersion"] = 4.2
    new["parameters"] = {
        "method": "POST",
        "url": base.rstrip("/") + path,
        "sendBody": True,
        "contentType": "json",
        "specifyBody": "keypair",
        "bodyParameters": {"parameters": [{"name": k, "value": v} for k, v in pairs if v not in (None, "")]},
        "options": {"timeout": 30000},
    }
    return new, op


def js(v):
    return json.dumps(v, ensure_ascii=False)


def convert(wf, base, source):
    if source == "active" and wf.get("activeVersion"):
        nodes, conns = wf["activeVersion"]["nodes"], wf["activeVersion"]["connections"]
    else:
        nodes, conns = wf["nodes"], wf["connections"]
    nodes = [dict(n) for n in nodes]
    swapped = []
    for i, n in enumerate(nodes):
        if n["type"] == GREEN_TYPE:
            nodes[i], op = gateway_node(n, base)
            swapped.append((n["name"], op))

    var = {n["name"]: f"n{i}" for i, n in enumerate(nodes)}
    by_name = {n["name"]: n for n in nodes}

    # sub-node (AI) attachments: child → parent
    subs = {}  # parent name → {key: [child names]}
    sub_kind = {}  # child name → factory
    for src, outs in conns.items():
        for ctype, groups in outs.items():
            if ctype == "main":
                continue
            if ctype not in SUBNODE_KINDS:
                raise ValueError(f"unsupported connection type {ctype}")
            factory, key, _many = SUBNODE_KINDS[ctype]
            for group in groups:
                for c in group:
                    subs.setdefault(c["node"], {}).setdefault(key, []).append(src)
                    sub_kind[src] = factory

    lines = ["import { workflow, node, trigger, languageModel, memory, tool, outputParser, embedding, "
             "documentLoader, textSplitter, retriever, vectorStore } from '@n8n/workflow-sdk';", ""]

    def node_decl(n):
        factory = sub_kind.get(n["name"]) or ("trigger" if TRIGGER_TYPES.search(n["type"]) else "node")
        cfg = {"name": n["name"], "parameters": n.get("parameters", {}), "position": n.get("position", [0, 0])}
        for k in CONFIG_KEYS:
            if k in n:
                cfg[k] = n[k]
        body = js(cfg)[:-1]
        if n["name"] in subs:
            parts = []
            for key, children in subs[n["name"]].items():
                many = next(m for f, k2, m in SUBNODE_KINDS.values() if k2 == key)
                refs = [var[c] for c in children]
                parts.append(f"{js(key)}: " + (f"[{', '.join(refs)}]" if many else refs[0]))
            body += ', "subnodes": {' + ", ".join(parts) + "}"
        body += "}"
        out = "" if factory not in ("node", "trigger") else ", output: [{}]"
        return f"const {var[n['name']]} = {factory}({{ type: {js(n['type'])}, version: {js(n['typeVersion'])}, config: {body}{out} }});"

    # declare sub-nodes first so parents can reference them
    order = [n for n in nodes if n["name"] in sub_kind] + [n for n in nodes if n["name"] not in sub_kind]
    for n in order:
        lines.append(node_decl(n))

    lines += ["", f"export default workflow({js(wf['id'])}, {js(wf['name'])})"]
    connected = set()
    for src, outs in conns.items():
        for out_idx, group in enumerate(outs.get("main", [])):
            for c in group:
                s = var[src] if out_idx == 0 else f"{var[src]}.output({out_idx})"
                d = var[c["node"]] if c.get("index", 0) == 0 else f"{var[c['node']]}.input({c['index']})"
                lines.append(f"  .add({s}.to({d}))")
                connected.update({src, c["node"]})
    for n in nodes:  # nodes with no main edges (sticky notes, lone triggers)
        if n["name"] not in connected and n["name"] not in sub_kind:
            lines.append(f"  .add({var[n['name']]})")
    lines[-1] += ";"
    return "\n".join(lines) + "\n", swapped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("details")
    ap.add_argument("--base", required=True)
    ap.add_argument("--source", choices=("active", "draft"), default="active")
    a = ap.parse_args()
    d = json.load(open(a.details, encoding="utf-8"))
    wf = d.get("workflow", d)
    code, swapped = convert(wf, a.base, a.source)
    sys.stdout.write(code)
    for name, op in swapped:
        print(f"swapped {name!r}: {op}", file=sys.stderr)


if __name__ == "__main__":
    main()
