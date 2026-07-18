# n8n — Landing-Page Leads Handler (ready to apply)

Goal: every CTA-form submission on a landing page reaches the agent **from
Forly's WhatsApp number** (prospects never talk to the agent directly), and the
prospect gets a confirmation.

The backend already POSTs each lead to the webhook configured in
`N8N_LEAD_WEBHOOK_URL` (`https://n8n.srv1173890.hstgr.cloud/webhook/lead-trigger`)
with this payload (see `functions/src/nadlan/leads.ts` / `server/index.js`):

```json
{
  "phone": "9725XXXXXXXX",          // prospect, digits only
  "name": "ישראל ישראלי",
  "message": "אשמח לתאם ביקור...",  // optional, may be null
  "source": "landing_page",
  "page_id": "…",
  "listing_id": "…",
  "agent_phone": "9725YYYYYYYY",
  "agent": { "name": "…", "brand_name": "…", "phone": "…", "license": "…" }
}
```

## Workflow shape

1. **Webhook** — POST `lead-trigger`, respond immediately (200).
2. **Format Lead** (Code) — build the two WhatsApp messages.
3. **Notify Agent** (GREEN-API sendMessage → `agent_phone@c.us`) — lead name +
   phone + property page link, sent from Forly's instance.
4. **Confirm Prospect** (GREEN-API sendMessage → `phone@c.us`) — "הפרטים
   התקבלו, {agent} יחזור אליך בהקדם".

## SDK code (paste into the n8n MCP `create_workflow_from_code` once the
n8n connector is reconnected; attach the existing GREEN-API credential to both
GREEN-API nodes, then publish)

```javascript
import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const leadWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Lead Trigger',
    parameters: { httpMethod: 'POST', path: 'lead-trigger', responseMode: 'onReceived' },
    position: [0, 0]
  },
  output: [{ body: { phone: '972501234567', name: 'ישראל ישראלי', message: '', source: 'landing_page', page_id: 'p1', listing_id: 'l1', agent_phone: '972507654321', agent: { name: 'רון גולן', brand_name: 'גולן נכסים' } } }]
});

const formatLead = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Format Lead',
    parameters: {
      jsCode: 'const b = $input.first().json.body || $input.first().json;\n' +
        'const agentName = (b.agent && (b.agent.name || b.agent.brand_name)) || "";\n' +
        'const local = "0" + String(b.phone || "").replace(/^972/, "");\n' +
        'const agentMsg = `🔔 ליד חדש מדף הנחיתה!\\n👤 ${b.name}\\n📞 ${local}` +\n' +
        '  (b.message ? `\\n💬 ${b.message}` : "") +\n' +
        '  `\\n\\nדף הנכס: https://forly.srv1173890.hstgr.cloud/p/${b.page_id}` +\n' +
        '  `\\nדברו איתו עכשיו: https://wa.me/${b.phone}`;\n' +
        'const prospectMsg = `תודה ${b.name}! הפרטים התקבלו 🦉` +\n' +
        '  (agentName ? `\\n${agentName} יחזור אליך בהקדם לתיאום ביקור.` : "\\nנחזור אליך בהקדם לתיאום ביקור.");\n' +
        'return [{ json: { agent_phone: b.agent_phone, prospect_phone: b.phone, agentMsg, prospectMsg } }];'
    },
    position: [220, 0]
  },
  output: [{ agent_phone: '972507654321', prospect_phone: '972501234567', agentMsg: '…', prospectMsg: '…' }]
});

const notifyAgent = node({
  type: 'n8n-nodes-greenapi.greenapi',
  version: 1,
  config: {
    name: 'Notify Agent',
    parameters: { chatId: expr('{{ $json.agent_phone }}@c.us'), message: expr('{{ $json.agentMsg }}') },
    position: [440, -80]
  },
  output: [{ idMessage: 'x' }]
});

const confirmProspect = node({
  type: 'n8n-nodes-greenapi.greenapi',
  version: 1,
  config: {
    name: 'Confirm Prospect',
    parameters: { chatId: expr('{{ $("Format Lead").item.json.prospect_phone }}@c.us'), message: expr('{{ $("Format Lead").item.json.prospectMsg }}') },
    position: [660, -80]
  },
  output: [{ idMessage: 'x' }]
});

export default workflow('forly-lead-handler', 'Forly Leads Handler')
  .add(leadWebhook)
  .to(formatLead)
  .to(notifyAgent)
  .to(confirmProspect);
```

Notes
- The Cloud Function already sends the agent a WhatsApp directly (best-effort),
  so leads are not lost while this workflow is missing; once the workflow is
  live you may remove the direct send in `leads.ts` to avoid double messages,
  or keep it as a backup.
- Set `N8N_LEAD_WEBHOOK_URL` in `functions/.env` / `server/.env` to the
  production webhook URL after publishing.
