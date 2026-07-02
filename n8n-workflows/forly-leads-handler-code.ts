import { workflow, node, trigger, switchCase, ifElse, expr, newCredential } from '@n8n/workflow-sdk';

// Triggers
const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Webhook Lead Trigger',
    parameters: {
      path: 'lead-trigger',
      httpMethod: 'POST',
      responseMode: 'onReceived',
      options: {
        noResponseBody: false,
        responseData: '{"success": true}'
      }
    },
    position: [240, 200]
  },
  output: [{ body: { phone: '972501234567', name: 'Test', city: 'Tel Aviv', specialty: 'apartments', source: 'web_new_user' } }]
});

const executeWorkflowTrig = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: {
    name: 'Execute Workflow Trigger',
    parameters: {
      inputSource: 'workflowInputs',
      workflowInputs: {
        values: [
          { name: 'phone', type: 'string' },
          { name: 'name', type: 'string' },
          { name: 'city', type: 'string' },
          { name: 'specialty', type: 'string' },
          { name: 'source', type: 'string' }
        ]
      }
    },
    position: [240, 400]
  },
  output: [{ phone: '972501234567', name: 'Test', city: 'Tel Aviv', specialty: 'apartments', source: 'whatsapp' }]
});

// Normalize input
const normalizeInput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Input',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `
const input = $input.first().json;
const phone = (input.phone || input.body?.phone || '').toString().replace(/\\D/g, '');

if (!/^\\d{10,15}$/.test(phone)) {
  throw new Error('Invalid phone number: ' + phone);
}

const normalized = {
  phone,
  name: input.name || input.body?.name || null,
  city: input.city || input.body?.city || null,
  specialty: input.specialty || input.body?.specialty || null,
  source: input.source || input.body?.source || 'whatsapp'
};

return [{ json: normalized }];
      `
    },
    position: [540, 300]
  },
  output: [{ phone: '972501234567', name: 'Test', city: 'Tel Aviv', specialty: 'apartments', source: 'web_new_user' }]
});

// Check existing lead
const checkExistingLead = node({
  type: 'n8n-nodes-base.googleFirebaseCloudFirestore',
  version: 1.1,
  config: {
    name: 'Check Existing Lead',
    parameters: {
      resource: 'document',
      operation: 'get',
      projectId: 'call4li',
      database: '(default)',
      collection: 'leads',
      documentId: expr`={{ $json.phone }}`,
      simple: true
    },
    credentials: {
      googleApi: newCredential('Google Service Account')
    },
    continueOnFail: true,
    position: [840, 300]
  },
  output: [{ _id: '972501234567', phone: '972501234567', status: 'new', name: 'Test' }]
});

// Route by lead status
const routeByStatus = switchCase({
  version: 3.4,
  config: {
    name: 'Route By Status',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          {
            conditions: {
              combinator: 'and',
              conditions: [{
                leftValue: expr`={{ $json.status }}`,
                rightValue: 'converted',
                operator: { type: 'string', operation: 'equals' }
              }],
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }
            },
            renameOutput: true,
            outputKey: 'already_converted'
          },
          {
            conditions: {
              combinator: 'or',
              conditions: [
                {
                  leftValue: expr`={{ $json.status }}`,
                  rightValue: 'carousel_sent',
                  operator: { type: 'string', operation: 'equals' }
                },
                {
                  leftValue: expr`={{ $json.status }}`,
                  rightValue: 'nudged',
                  operator: { type: 'string', operation: 'equals' }
                }
              ],
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }
            },
            renameOutput: true,
            outputKey: 'continue_funnel'
          }
        ]
      },
      options: {
        fallbackOutput: 'extra',
        renameFallbackOutput: 'new_lead'
      }
    },
    position: [1140, 300]
  }
});

// Already converted - send message and END
const alreadyConvertedMsg = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.3,
  config: {
    name: 'Already Converted Message',
    parameters: {
      method: 'POST',
      url: expr`={{ 'https://7103.api.greenapi.com/waInstance' + $env.GREENAPI_INSTANCE + '/sendMessage/' + $env.GREENAPI_TOKEN }}`,
      sendBody: true,
      bodyParameters: {
        parameters: [
          { name: 'chatId', value: expr`={{ $('Normalize Input').first().json.phone + '@c.us' }}` },
          { name: 'message', value: 'כבר יצרנו לך חשבון! 🦉\nשלח "הצטרפות" כדי להתחיל לקבל תוכן שיווקי שבועי.' }
        ]
      },
      options: {}
    },
    position: [1440, 100]
  },
  output: [{ idMessage: 'msg123' }]
});

// Write new lead
const writeNewLead = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Lead Document',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `
const normalized = $('Normalize Input').first().json;
const now = new Date().toISOString();

const leadDoc = {
  phone: normalized.phone,
  name: normalized.name,
  city: normalized.city,
  specialty: normalized.specialty,
  status: 'new',
  source: normalized.source,
  created_at: now,
  updated_at: now,
  funnel_step: 0
};

// Convert to Firestore format
const fields = {};
for (const [key, value] of Object.entries(leadDoc)) {
  if (value === null) {
    fields[key] = { nullValue: null };
  } else if (typeof value === 'string') {
    fields[key] = { stringValue: value };
  } else if (typeof value === 'number') {
    fields[key] = { integerValue: value };
  }
}

return [{ json: { phone: leadDoc.phone, fields } }];
      `
    },
    position: [1440, 400]
  },
  output: [{ phone: '972501234567', fields: {} }]
});

const createLeadDoc = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.3,
  config: {
    name: 'Create Lead in Firestore',
    parameters: {
      method: 'PATCH',
      url: expr`={{ 'https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/leads/' + $json.phone }}`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleApi',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr`={{ JSON.stringify({ fields: $json.fields }) }}`,
      options: {}
    },
    credentials: {
      googleApi: newCredential('Google Service Account')
    },
    position: [1740, 400]
  },
  output: [{ name: 'leads/972501234567', updateTime: '2025-01-01T00:00:00Z' }]
});

// WhatsApp ack
const whatsappAck = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.3,
  config: {
    name: 'WhatsApp Ack',
    parameters: {
      method: 'POST',
      url: expr`={{ 'https://7103.api.greenapi.com/waInstance' + $env.GREENAPI_INSTANCE + '/sendMessage/' + $env.GREENAPI_TOKEN }}`,
      sendBody: true,
      bodyParameters: {
        parameters: [
          { name: 'chatId', value: expr`={{ $('Normalize Input').first().json.phone + '@c.us' }}` },
          { name: 'message', value: expr`={{ 'היי ' + ($('Normalize Input').first().json.name || 'מתווך') + '! 🦉\\nמכינה לך עכשיו קרוסלה ממוקדת לשוק שלך — תוך כמה דקות כאן 📲' }}` }
        ]
      },
      options: {}
    },
    position: [2040, 400]
  },
  output: [{ idMessage: 'msg456' }]
});

// Synthesize topic with Haiku
const synthesizeTopic = node({
  type: '@n8n/n8n-nodes-langchain.anthropic',
  version: 1,
  config: {
    name: 'Synthesize Topic',
    parameters: {
      resource: 'text',
      operation: 'message',
      modelId: { mode: 'list', value: 'claude-haiku-4-5-20251001' },
      messages: {
        values: [{
          role: 'user',
          content: expr`={{ 'Real-estate agent specialty: ' + ($('Normalize Input').first().json.specialty || 'general') + ', city: ' + ($('Normalize Input').first().json.city || 'Israel') + '. Generate: topic (Hebrew, one line carousel hook) and business_desc (Hebrew, one sentence). Return ONLY valid JSON: {"topic": "...", "business_desc": "..."}' }}`
        }]
      },
      simplify: true,
      options: {
        maxTokens: 150,
        temperature: 0.7
      }
    },
    credentials: {
      anthropicApi: newCredential('Anthropic')
    },
    position: [2340, 400]
  },
  output: [{ content: [{ type: 'text', text: '{"topic": "דירות ממוקדות בתל אביב", "business_desc": "מתווך נדל\\"ן מתמחה בדירות מגורים"}' }] }]
});

const parseTopic = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse Topic',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `
const text = $input.first().json.content[0].text;
const parsed = JSON.parse(text);
const normalized = $('Normalize Input').first().json;

return [{
  json: {
    phone: normalized.phone,
    business_name: normalized.name || 'מתווך נדל\\"ן',
    business_desc: parsed.business_desc,
    topic: parsed.topic
  }
}];
      `
    },
    position: [2640, 400]
  },
  output: [{ phone: '972501234567', business_name: 'Test', business_desc: 'מתווך...', topic: 'דירות...' }]
});

// Generate carousel
const generateCarousel = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Generate Carousel',
    parameters: {
      source: 'database',
      workflowId: { mode: 'id', value: 'Oksvt7PPwDCZXDep' },
      workflowInputs: expr`={{ JSON.stringify({
        phone: $json.phone,
        business_name: $json.business_name,
        business_desc: $json.business_desc,
        topic: $json.topic
      }) }}`,
      mode: 'once',
      options: {
        waitForSubWorkflow: true
      }
    },
    position: [2940, 400]
  },
  output: [{ caption: '...', editor_url: 'https://...', slide_urls: [], first_slide_url: 'https://...' }]
});

// Update lead status
const updateLeadCarouselSent = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Lead Update',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `
const phone = $('Parse Topic').first().json.phone;
const carousel = $input.first().json;
const now = new Date().toISOString();

const updates = {
  status: 'carousel_sent',
  funnel_step: 1,
  updated_at: now,
  carousel: {
    slide_urls: carousel.slide_urls,
    caption: carousel.caption,
    editor_url: carousel.editor_url,
    first_slide_url: carousel.first_slide_url,
    sent_at: now
  }
};

const fields = {};
fields.status = { stringValue: 'carousel_sent' };
fields.funnel_step = { integerValue: 1 };
fields.updated_at = { stringValue: now };
fields.carousel = { mapValue: { fields: {
  slide_urls: { arrayValue: { values: carousel.slide_urls.map(u => ({ stringValue: u })) } },
  caption: { stringValue: carousel.caption },
  editor_url: { stringValue: carousel.editor_url },
  first_slide_url: { stringValue: carousel.first_slide_url },
  sent_at: { stringValue: now }
}}};

return [{ json: { phone, fields } }];
      `
    },
    position: [3240, 400]
  },
  output: [{ phone: '972501234567', fields: {} }]
});

const patchLeadCarousel = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.3,
  config: {
    name: 'Update Lead Carousel Sent',
    parameters: {
      method: 'PATCH',
      url: expr`={{ 'https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/leads/' + $json.phone + '?updateMask.fieldPaths=status&updateMask.fieldPaths=funnel_step&updateMask.fieldPaths=updated_at&updateMask.fieldPaths=carousel' }}`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleApi',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr`={{ JSON.stringify({ fields: $json.fields }) }}`,
      options: {}
    },
    credentials: {
      googleApi: newCredential('Google Service Account')
    },
    position: [3540, 400]
  },
  output: [{ name: 'leads/972501234567', updateTime: '2025-01-01T00:00:00Z' }]
});

// Follow-up #1
const followUp1 = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.3,
  config: {
    name: 'Follow-up #1',
    parameters: {
      method: 'POST',
      url: expr`={{ 'https://7103.api.greenapi.com/waInstance' + $env.GREENAPI_INSTANCE + '/sendMessage/' + $env.GREENAPI_TOKEN }}`,
      sendBody: true,
      bodyParameters: {
        parameters: [
          { name: 'chatId', value: expr`={{ $('Prepare Lead Update').first().json.phone + '@c.us' }}` },
          { name: 'message', value: expr`={{ '✅ הקרוסלה שלך מוכנה!\\nלערוך (24ש): ' + $('Generate Carousel').first().json.editor_url + '\\n💡 העלה היום 18:00–20:00 — שעות שיא לנדל"ן.' }}` }
        ]
      },
      options: {}
    },
    position: [3840, 400]
  },
  output: [{ idMessage: 'msg789' }]
});

// Wait 60 minutes
const wait60m = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: {
    name: 'Wait 60 Minutes',
    parameters: {
      resume: 'timeInterval',
      amount: 60,
      unit: 'minutes'
    },
    position: [4140, 400]
  },
  output: [{}]
});

// Update funnel step 2 + Follow-up #2
const updateFunnelStep2 = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Funnel Step 2',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `
const phone = $('Prepare Lead Update').first().json.phone;
const now = new Date().toISOString();

const fields = {
  funnel_step: { integerValue: 2 },
  updated_at: { stringValue: now }
};

return [{ json: { phone, fields } }];
      `
    },
    position: [4440, 400]
  },
  output: [{ phone: '972501234567', fields: {} }]
});

const patchFunnelStep2 = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.3,
  config: {
    name: 'Update Funnel Step 2',
    parameters: {
      method: 'PATCH',
      url: expr`={{ 'https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/leads/' + $json.phone + '?updateMask.fieldPaths=funnel_step&updateMask.fieldPaths=updated_at' }}`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleApi',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr`={{ JSON.stringify({ fields: $json.fields }) }}`,
      options: {}
    },
    credentials: {
      googleApi: newCredential('Google Service Account')
    },
    position: [4740, 400]
  },
  output: [{ name: 'leads/972501234567', updateTime: '2025-01-01T00:00:00Z' }]
});

const followUp2 = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.3,
  config: {
    name: 'Follow-up #2',
    parameters: {
      method: 'POST',
      url: expr`={{ 'https://7103.api.greenapi.com/waInstance' + $env.GREENAPI_INSTANCE + '/sendMessage/' + $env.GREENAPI_TOKEN }}`,
      sendBody: true,
      bodyParameters: {
        parameters: [
          { name: 'chatId', value: expr`={{ $('Prepare Funnel Step 2').first().json.phone + '@c.us' }}` },
          { name: 'message', value: 'העלית? ספר לי איך הגיבו 🦉\\nזו רק דוגמה אחת ממה שפורלי עושה לך כל שבוע אוטומטית.\\nרוצה את השירות המלא? כתוב "כן"' }
        ]
      },
      options: {}
    },
    position: [5040, 400]
  },
  output: [{ idMessage: 'msg101' }]
});

// Wait 24 hours
const wait24h = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: {
    name: 'Wait 24 Hours',
    parameters: {
      resume: 'timeInterval',
      amount: 24,
      unit: 'hours'
    },
    position: [5340, 400]
  },
  output: [{}]
});

// Update funnel step 3 + Follow-up #3
const updateFunnelStep3 = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Funnel Step 3',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `
const phone = $('Prepare Lead Update').first().json.phone;
const now = new Date().toISOString();

const fields = {
  funnel_step: { integerValue: 3 },
  updated_at: { stringValue: now }
};

return [{ json: { phone, fields } }];
      `
    },
    position: [5640, 400]
  },
  output: [{ phone: '972501234567', fields: {} }]
});

const patchFunnelStep3 = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.3,
  config: {
    name: 'Update Funnel Step 3',
    parameters: {
      method: 'PATCH',
      url: expr`={{ 'https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/leads/' + $json.phone + '?updateMask.fieldPaths=funnel_step&updateMask.fieldPaths=updated_at' }}`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleApi',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr`={{ JSON.stringify({ fields: $json.fields }) }}`,
      options: {}
    },
    credentials: {
      googleApi: newCredential('Google Service Account')
    },
    position: [5940, 400]
  },
  output: [{ name: 'leads/972501234567', updateTime: '2025-01-01T00:00:00Z' }]
});

const followUp3 = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.3,
  config: {
    name: 'Follow-up #3',
    parameters: {
      method: 'POST',
      url: expr`={{ 'https://7103.api.greenapi.com/waInstance' + $env.GREENAPI_INSTANCE + '/sendMessage/' + $env.GREENAPI_TOKEN }}`,
      sendBody: true,
      bodyParameters: {
        parameters: [
          { name: 'chatId', value: expr`={{ $('Prepare Funnel Step 3').first().json.phone + '@c.us' }}` },
          { name: 'message', value: 'פורלי כל שבוע: תכנית שיווקית · קרוסלות+תמונות+סרטוני דירה · דוח ביצועים.\\nהכל בוואטסאפ, בלי לדעת מה לפרסם.\\nרוצה להצטרף? כתוב "הצטרפות"' }
        ]
      },
      options: {}
    },
    position: [6240, 400]
  },
  output: [{ idMessage: 'msg202' }]
});

// Compose workflow
export default workflow('forly-leads-handler', 'Forly Leads Handler')
  .add(webhookTrigger)
  .to(normalizeInput)
  .to(checkExistingLead)
  .to(routeByStatus
    .onCase('already_converted', alreadyConvertedMsg)
    .onCase('continue_funnel', followUp2) // Skip to follow-up #2 for existing leads
    .onCase('new_lead', writeNewLead.to(createLeadDoc).to(whatsappAck).to(synthesizeTopic).to(parseTopic).to(generateCarousel).to(updateLeadCarouselSent).to(patchLeadCarousel).to(followUp1).to(wait60m).to(updateFunnelStep2).to(patchFunnelStep2).to(followUp2).to(wait24h).to(updateFunnelStep3).to(patchFunnelStep3).to(followUp3))
  )
  .add(executeWorkflowTrig)
  .to(normalizeInput);
