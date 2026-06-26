# Vision Tagger — n8n Workflow Spec

**Type:** Sub-workflow (called by WW1)
**Status:** New (inactive draft)
**Input:** `{image_urls: string[]}`
**Output:** `{tags: [...]}` per Part 10.4

## Nodes

1. **Trigger**: executeWorkflowTrigger
   - Receives `image_urls[]`

2. **SplitInBatches**: batch size 5
   - Input: `image_urls`
   - Outputs batches of ≤5 URLs

3. **Per-batch**: HTTP Request (Anthropic API)
   - **Method**: POST
   - **URL**: `https://api.anthropic.com/v1/messages`
   - **Headers**:
     - `x-api-key`: `{{$credentials.anthropicApi.apiKey}}`
     - `anthropic-version`: `2023-06-01`
     - `Content-Type`: `application/json`
   - **Body**:
     ```json
     {
       "model": "claude-haiku-4-5-20251001",
       "max_tokens": 400,
       "messages": [
         {
           "role": "user",
           "content": [
             ...batch.map(url => ({type: "image", source: {type: "url", url}})),
             {
               "type": "text",
               "text": "For each image, return strict JSON array: [{url, is_real_estate: bool, category: string, room_type: string, quality_score: 1-10, lighting: string, description: string, noted_features: string[]}]. No markdown, only JSON array."
             }
           ]
         }
       ]
     }
     ```
   - **Timeout**: 60s

4. **Parse JSON**: `JSON.parse(response.content[0].text)`
   - Extract tags array
   - Validate schema (has required fields)

5. **Merge**: Aggregate all batches
   - Flatten tag arrays
   - Return `{tags: [...]}`

6. **Error handling**: Code node
   - Catch invalid JSON → fallback minimal tag: `{url, is_real_estate: null, quality_score: 5}`

## Credentials

- **Anthropic API**: Header Auth cred with `x-api-key`

## Notes

- Haiku vision: ~$0.002/image
- Batching reduces API calls (5 imgs/call)
- Strict JSON mode ensures parseable output
