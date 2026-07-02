/**
 * Business Handler Agents - Modular Feature Code
 *
 * These are SDK snippets for the 7 new features to add to BH2 fork.
 * After forking BH2 in n8n UI, add these nodes and connect them to the existing flow.
 */

import { workflow, node, trigger, switchCase, expr, newCredential } from '@n8n/workflow-sdk';

// =============================================================================
// FEATURE 1: Burst Bundle Detection (Entry Node)
// =============================================================================

const checkBurstBundle = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Check Burst Bundle',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `
// Check for stacked images from previous messages
const trigger = $input.first().json;
const phone = trigger.senderData?.chatId?.replace('@c.us', '') || trigger.phone;
const messageType = trigger.typeMessage || trigger.type;
const imageUrl = trigger.downloadUrl || trigger.media_url;

// Get burst context (if exists from previous run)
const context = $input.first().json.burst_context || {};
const currentBurstImages = context.stacked_images || [];

// If this is an image, add to burst stack
if (messageType === 'imageMessage' && imageUrl) {
  currentBurstImages.push({
    url: imageUrl,
    timestamp: new Date().toISOString()
  });
}

return [{
  json: {
    ...trigger,
    phone,
    current_burst_images: currentBurstImages,
    burst_count: currentBurstImages.length
  }
}];
`
    },
    position: [540, 300]
  },
  output: [{ phone: '1234567890', current_burst_images: [], burst_count: 0 }]
});

// =============================================================================
// FEATURE 2: Walkthrough Trigger Logic
// =============================================================================

const checkWalkthroughTrigger = switchCase({
  version: 3.4,
  config: {
    name: 'Check Walkthrough Trigger',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          {
            conditions: {
              options: { caseSensitive: false, leftValue: '', typeValidation: 'strict' },
              combinator: 'or',
              conditions: [
                {
                  leftValue: expr`{{ $json.burst_count }}`,
                  rightValue: '4',
                  operator: { type: 'number', operation: 'gte' }
                },
                {
                  leftValue: expr`{{ $json.messageData?.textMessageData?.textMessage }}`,
                  rightValue: '(סרטון|סיור|וידאו)',
                  operator: { type: 'string', operation: 'regex' }
                }
              ]
            },
            renameOutput: true,
            outputKey: 'ask_walkthrough'
          }
        ]
      },
      options: {
        fallbackOutput: 'extra',
        renameFallbackOutput: 'continue_normal'
      }
    },
    position: [740, 300]
  }
});

// Persist images to Firebase Storage
const persistImages = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Persist Images',
    parameters: {
      method: 'POST',
      url: expr`{{ $env.FIREBASE_FUNCTIONS_URL }}/persistMedia`,
      sendBody: true,
      contentType: 'json',
      jsonBody: expr`{{ { phone: $json.phone, images: $json.current_burst_images } }}`,
      options: {
        response: {
          response: {
            responseFormat: 'json'
          }
        }
      }
    },
    position: [940, 200]
  },
  output: [{ burst_id: 'burst_123', image_urls: ['url1', 'url2'] }]
});

// Create pending walkthrough confirmation in Firestore
const createPendingConfirmation = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Create Pending Confirmation',
    parameters: {
      method: 'PATCH',
      url: expr`https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/pending_walkthrough_confirm/{{ $json.phone }}`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleApi',
      sendBody: true,
      contentType: 'json',
      jsonBody: expr`{{
        {
          "fields": {
            "burst_id": { "stringValue": $('Persist Images').first().json.burst_id },
            "image_urls": {
              "arrayValue": {
                "values": $('Persist Images').first().json.image_urls.map(u => ({ stringValue: u }))
              }
            },
            "expires_at": { "stringValue": $now.plus({ minutes: 10 }).toISO() }
          }
        }
      }}`
    },
    credentials: {
      googleApi: newCredential('Google Service Account')
    },
    position: [1140, 200]
  },
  output: [{}]
});

// Send walkthrough confirmation buttons via Green-API
const sendWalkthroughButtons = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Send Walkthrough Buttons',
    parameters: {
      method: 'POST',
      url: expr`https://api.green-api.com/waInstance{{ $env.GREENAPI_INSTANCE }}/sendButtons/{{ $env.GREENAPI_TOKEN }}`,
      sendBody: true,
      contentType: 'json',
      jsonBody: expr`{{
        {
          "chatId": $json.phone + "@c.us",
          "message": "מצאתי " + $json.burst_count + " תמונות 📸\\nרוצה שאצור סרטון סיור?",
          "buttons": [
            { "id": "yes_walkthrough", "text": "כן, צור סרטון 🎬" },
            { "id": "no_walkthrough", "text": "לא תודה" }
          ]
        }
      }}`
    },
    position: [1340, 200]
  },
  output: [{ idMessage: 'msg_123' }]
});

// =============================================================================
// FEATURE 3: Walkthrough Execution (on "yes" button)
// =============================================================================

const getPendingConfirmation = node({
  type: 'n8n-nodes-base.googleFirebaseCloudFirestore',
  version: 1.1,
  config: {
    name: 'Get Pending Confirmation',
    parameters: {
      resource: 'document',
      operation: 'get',
      authentication: 'serviceAccount',
      projectId: 'call4li',
      database: '(default)',
      collection: 'pending_walkthrough_confirm',
      documentId: expr`{{ $json.phone }}`,
      simple: true
    },
    credentials: {
      googleApi: newCredential('Google Service Account')
    },
    position: [940, 400]
  },
  output: [{ burst_id: 'burst_123', image_urls: ['url1', 'url2'] }]
});

const createListing = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Create Listing',
    parameters: {
      method: 'POST',
      url: 'https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/listings',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleApi',
      sendBody: true,
      contentType: 'json',
      jsonBody: expr`{{
        {
          "fields": {
            "source": { "stringValue": "chat_burst" },
            "phone": { "stringValue": $json.phone },
            "photos_urls": {
              "arrayValue": {
                "values": $('Get Pending Confirmation').first().json.image_urls.map(url => ({ stringValue: url }))
              }
            },
            "status": { "stringValue": "active" },
            "created_at": { "stringValue": $now.toISO() }
          }
        }
      }}`
    },
    credentials: {
      googleApi: newCredential('Google Service Account')
    },
    position: [1140, 400]
  },
  output: [{ name: 'listings/abc123' }]
});

const executeWW1Workflow = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.1,
  config: {
    name: 'Execute WW1 Workflow',
    parameters: {
      source: 'database',
      workflowId: { __rl: true, mode: 'list', value: 'vHUj7CfmGQszcRV7' },
      waitForCompletion: true,
      fields: {
        values: [
          {
            name: 'phone',
            value: expr`{{ $json.phone }}`
          },
          {
            name: 'listing_id',
            value: expr`{{ $('Create Listing').first().json.name.split('/')[1] }}`
          },
          {
            name: 'trigger_source',
            value: 'business_handler'
          }
        ]
      }
    },
    position: [1340, 400]
  },
  output: [{ video_url: 'https://...' }]
});

const removePendingConfirmation = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Remove Pending Confirmation',
    parameters: {
      method: 'DELETE',
      url: expr`https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/pending_walkthrough_confirm/{{ $json.phone }}`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleApi'
    },
    credentials: {
      googleApi: newCredential('Google Service Account')
    },
    position: [1540, 400]
  },
  output: [{}]
});

// =============================================================================
// FEATURE 4: Weekly Plan Approval Detection
// =============================================================================

const classifyPlanResponse = node({
  type: '@n8n/n8n-nodes-langchain.anthropic',
  version: 1,
  config: {
    name: 'Classify Plan Response',
    parameters: {
      resource: 'text',
      operation: 'message',
      modelId: { __rl: true, mode: 'list', value: 'claude-haiku-4-5-20251001' },
      messages: {
        values: [
          {
            content: expr`User message: '{{ $json.message }}'. Classify intent: approve | change | reject | unrelated. Return JSON only: {"intent": "approve"}`,
            role: 'user'
          }
        ]
      },
      simplify: true,
      options: {
        maxTokens: 100
      }
    },
    credentials: {
      anthropicApi: newCredential('Anthropic API')
    },
    position: [940, 600]
  },
  output: [{ output: '{"intent": "approve"}' }]
});

const routeByIntent = switchCase({
  version: 3.4,
  config: {
    name: 'Route by Intent',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              combinator: 'and',
              conditions: [
                {
                  leftValue: expr`{{ JSON.parse($json.output).intent }}`,
                  rightValue: 'approve',
                  operator: { type: 'string', operation: 'equals' }
                }
              ]
            },
            renameOutput: true,
            outputKey: 'approve'
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              combinator: 'and',
              conditions: [
                {
                  leftValue: expr`{{ JSON.parse($json.output).intent }}`,
                  rightValue: 'change',
                  operator: { type: 'string', operation: 'equals' }
                }
              ]
            },
            renameOutput: true,
            outputKey: 'change'
          }
        ]
      },
      options: {
        fallbackOutput: 'extra',
        renameFallbackOutput: 'continue'
      }
    },
    position: [1140, 600]
  }
});

const updatePlanApproved = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Update Plan Approved',
    parameters: {
      method: 'PATCH',
      url: expr`https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/weekly_plans/{{ $json.plan_id }}`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleApi',
      sendQuery: true,
      specifyQuery: 'keypair',
      queryParameters: {
        parameters: [
          {
            name: 'updateMask.fieldPaths',
            value: 'status'
          },
          {
            name: 'updateMask.fieldPaths',
            value: 'approved_at'
          }
        ]
      },
      sendBody: true,
      contentType: 'json',
      jsonBody: expr`{{
        {
          "fields": {
            "status": { "stringValue": "approved" },
            "approved_at": { "stringValue": $now.toISO() }
          }
        }
      }}`
    },
    credentials: {
      googleApi: newCredential('Google Service Account')
    },
    position: [1340, 600]
  },
  output: [{}]
});

// =============================================================================
// FEATURE 5: Victory/Deal Detection (every message)
// =============================================================================

const detectVictoryDeal = node({
  type: '@n8n/n8n-nodes-langchain.anthropic',
  version: 1,
  config: {
    name: 'Detect Victory/Deal',
    parameters: {
      resource: 'text',
      operation: 'message',
      modelId: { __rl: true, mode: 'list', value: 'claude-haiku-4-5-20251001' },
      messages: {
        values: [
          {
            content: expr`Message: '{{ $json.message }}'. Classify: {"is_inquiry": bool, "is_deal": bool}. Inquiry keywords: פנייה/לקוח/מתעניין. Deal keywords: סגרתי/עסקה/חתמנו. JSON only.`,
            role: 'user'
          }
        ]
      },
      simplify: true,
      options: {
        maxTokens: 50
      }
    },
    credentials: {
      anthropicApi: newCredential('Anthropic API')
    },
    position: [540, 800]
  },
  output: [{ output: '{"is_inquiry": false, "is_deal": false}' }]
});

const routeVictory = switchCase({
  version: 3.4,
  config: {
    name: 'Route Victory',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              combinator: 'and',
              conditions: [
                {
                  leftValue: expr`{{ JSON.parse($json.output).is_inquiry }}`,
                  rightValue: 'true',
                  operator: { type: 'boolean', operation: 'true' }
                }
              ]
            },
            renameOutput: true,
            outputKey: 'inquiry'
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              combinator: 'and',
              conditions: [
                {
                  leftValue: expr`{{ JSON.parse($json.output).is_deal }}`,
                  rightValue: 'true',
                  operator: { type: 'boolean', operation: 'true' }
                }
              ]
            },
            renameOutput: true,
            outputKey: 'deal'
          }
        ]
      },
      options: {
        fallbackOutput: 'extra',
        renameFallbackOutput: 'continue'
      }
    },
    position: [740, 800]
  }
});

const incrementInquiries = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Increment Inquiries',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `
const businessData = $('Get Business').first().json;
const currentCount = businessData.total_inquiries_reported || 0;

return [{
  json: {
    phone: $json.phone,
    new_count: currentCount + 1
  }
}];
`
    },
    position: [940, 750]
  },
  output: [{ phone: '1234567890', new_count: 1 }]
});

const updateInquiryCount = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Update Inquiry Count',
    parameters: {
      method: 'PATCH',
      url: expr`https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/businesses/{{ $json.phone }}`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleApi',
      sendQuery: true,
      specifyQuery: 'keypair',
      queryParameters: {
        parameters: [
          {
            name: 'updateMask.fieldPaths',
            value: 'total_inquiries_reported'
          }
        ]
      },
      sendBody: true,
      contentType: 'json',
      jsonBody: expr`{{
        {
          "fields": {
            "total_inquiries_reported": { "integerValue": String($json.new_count) }
          }
        }
      }}`
    },
    credentials: {
      googleApi: newCredential('Google Service Account')
    },
    position: [1140, 750]
  },
  output: [{}]
});

const createInquiryEvent = node({
  type: 'n8n-nodes-base.googleFirebaseCloudFirestore',
  version: 1.1,
  config: {
    name: 'Create Inquiry Event',
    parameters: {
      resource: 'document',
      operation: 'create',
      authentication: 'serviceAccount',
      projectId: 'call4li',
      database: '(default)',
      collection: expr`businesses/{{ $json.phone }}/events`,
      columns: 'type,ts',
      simple: true
    },
    credentials: {
      googleApi: newCredential('Google Service Account')
    },
    position: [1340, 750]
  },
  output: [{ type: 'inquiry_reported', ts: new Date().toISOString() }]
});

const replyInquiry = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Reply Inquiry',
    parameters: {
      method: 'POST',
      url: expr`https://api.green-api.com/waInstance{{ $env.GREENAPI_INSTANCE }}/sendMessage/{{ $env.GREENAPI_TOKEN }}`,
      sendBody: true,
      contentType: 'json',
      jsonBody: expr`{{
        {
          "chatId": $json.phone + "@c.us",
          "message": "🏆 " + $json.business_name + " — קיבלת פנייה מהתוכן! זה בדיוק מה שבנינו יחד ✨"
        }
      }}`
    },
    position: [1540, 750]
  },
  output: [{ idMessage: 'msg_123' }]
});

// Similar nodes for "deal" branch (increment total_deals_closed, create event, reply)

// =============================================================================
// FEATURE 6: Smart Memory (last 3 events)
// =============================================================================

const getRecentEvents = node({
  type: 'n8n-nodes-base.googleFirebaseCloudFirestore',
  version: 1.1,
  config: {
    name: 'Get Recent Events',
    parameters: {
      resource: 'document',
      operation: 'query',
      authentication: 'serviceAccount',
      projectId: 'call4li',
      database: '(default)',
      query: expr`{{
        JSON.stringify({
          "structuredQuery": {
            "from": [{ "collectionId": "businesses/" + $json.phone + "/events" }],
            "where": {
              "fieldFilter": {
                "field": { "fieldPath": "type" },
                "op": "EQUAL",
                "value": { "stringValue": "content_requested" }
              }
            },
            "orderBy": [{ "field": { "fieldPath": "ts" }, "direction": "DESCENDING" }],
            "limit": 3
          }
        })
      }}`,
      simple: true
    },
    credentials: {
      googleApi: newCredential('Google Service Account')
    },
    position: [540, 1000]
  },
  output: [
    { type: 'content_requested', content_type: 'carousel', ts: '2025-07-01T10:00:00Z' },
    { type: 'content_requested', content_type: 'image', ts: '2025-06-30T15:00:00Z' }
  ]
});

const buildContextWithMemory = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Context With Memory',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `
const recentEvents = $('Get Recent Events').all() || [];
const eventContext = recentEvents.map(e =>
  \`- \${e.json.content_type} on \${e.json.ts}\`
).join('\\n');

const basePrompt = $json.existing_prompt || 'You are a helpful assistant';

const enhancedPrompt = \`
\${basePrompt}

Recent content requests:
\${eventContext}
\`;

return [{
  json: {
    ...$json,
    agent_prompt: enhancedPrompt
  }
}];
`
    },
    position: [740, 1000]
  },
  output: [{ agent_prompt: 'Enhanced prompt with context' }]
});

// =============================================================================
// FEATURE 7: Field Remapping (businessData.* → direct)
// =============================================================================

// This is a search-and-replace operation in ALL nodes:
//
// Find:    {{ $json.businessData.full_name }}
// Replace: {{ $json.full_name }}
//
// Find:    {{ $json.businessData.phone }}
// Replace: {{ $json.phone }}
//
// Find:    {{ $json.businessData.city }}
// Replace: {{ $json.city }}
//
// etc. for all fields: specialty, status, created_at, quota_remaining, etc.
//
// Use n8n's global search (Ctrl+F) in the workflow editor to find ALL instances.

// =============================================================================
// NOTES ON INTEGRATION
// =============================================================================

/*
To integrate these features into your forked BH2 workflow:

1. Fork BH2 manually in n8n UI (Duplicate button)
2. Add each feature's nodes at the appropriate location:
   - Feature 1: At entry point (first node after trigger)
   - Feature 2-3: After entry processing, before agent logic
   - Feature 4: In message response handling
   - Feature 5: In every inbound message processing
   - Feature 6: Before building agent prompt
   - Feature 7: Global search-replace in ALL nodes

3. Connect the new nodes to existing flow:
   - checkBurstBundle → existing router
   - checkWalkthroughTrigger → persistImages (ask branch) or continue (normal branch)
   - detectVictoryDeal → routeVictory → inquiry/deal handlers or continue

4. Test each feature independently before activating the workflow

5. Keep BH2 as FROZEN for rollback
*/
