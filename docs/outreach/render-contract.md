# Version 1 render callback contract

Node is the canonical implementation. This contract requires the n8n workflow to sign requests; update workflow credentials before production rollout. Do not reuse the session secret. Production boot requires `CALLBACK_HMAC_SECRET` with at least 32 characters. For isolated development only, `CALLBACK_ALLOW_UNSIGNED_LOCAL=1` permits legacy callbacks when no secret is configured.

POST `/api/video-overlay` with JSON:

```json
{"brandMode":"outreach_demo","demo_id":"demo_test_123","correlation_id":"build_123","video_urls":["https://media.example/clip.mp4"],"lines":["Property preview"]}
```

Headers: `x-forly-timestamp` (13-digit Unix milliseconds), `x-forly-request-id` (unique 16–128 character alphanumeric, underscore or hyphen), `x-forly-signature` (lowercase hex HMAC-SHA256). Signing input is `purpose + "\n" + timestamp + "\n" + requestId + "\n" + canonicalJSON(body)`. Canonical JSON recursively sorts object keys, preserves array order, and has no whitespace. Purposes are `overlay` for `/api/video-overlay`, `page` for `/createPropertyPage`. Use exported `signCallback` from `server/callback-auth.js` in a trusted Node workflow step. Never send secrets to browsers.

The clock tolerance is five minutes. Duplicate callback IDs return 409 and must not be blindly retried under a new ID. Keep the original correlation/job record for reconciliation. Global daily/concurrency admission is reserved durably by the application's callback reservation adapter; process-local limits also protect a single instance. Defaults are 100 callbacks/day and two concurrent calls, configurable with `CALLBACK_MAX_DAILY` and `CALLBACK_MAX_CONCURRENT`. JSON callback bodies are bounded to 256 KiB.

Response:

```json
{"brand_mode":"outreach_demo","watermark_version":"forly-central-v1","duration":10,"renditions":[{"id":"asset_demo","rendition":"watermarked_demo"},{"id":"asset_paid","rendition":"clean_paid"}]}
```

Ordering is not contractual. Select by rendition and validate the manifest ID and watermark version; never derive filenames. Only `watermarked_demo` may attach to an active unpaid demo. Private paths and source URLs must not enter the response. The asset adapter must copy temporary rendition bytes before resolving. A late callback cannot activate an expired/deleted demo.

The `forly-central-v1` watermark is a persistent white 72%-opacity central Forly wordmark, 15% of video width in font size, with a dark outline. It is composited into every frame by ffmpeg, H.264/yuv420p/faststart. The private paid output has no promotional end titles. Existing `promo_titled` renders retain their prior behavior. Design approval for this exact wordmark, opacity and size is still a pilot prerequisite.

Verification: `node server/callback-auth.test.js`, `node server/overlay.test.js`, and `node server/overlay-outreach.test.js` (requires ffmpeg/ffprobe with drawtext). The integration test checks codec, pixels in the central area at beginning/middle/end, duration and faststart. Deployment images must include drawtext and existing libass/Hebrew fonts.

## Pipeline webhook and private image exchange

`server/outreach/pipeline.js` emits the checked-in [pipeline request fixture](fixtures/pipeline-request.v1.json) to `OUTREACH_N8N_WEBHOOK_URL`. The versioned [JSON Schema](render.v1.schema.json) defines `pipelineRequest`, `overlayRequest`, and `overlayResponse` under `$defs`. Validate the appropriate `$defs` in n8n before processing; reject unsupported versions and `brandMode` values. Fixtures contain deliberately invalid placeholder signatures and example domains, never live credentials or prospect material.

The webhook HTTP request uses POST, `Content-Type: application/json`, purpose **`pipeline`**, the callback HMAC headers above, a 15-second acknowledgement deadline, and no HTTP redirects. Its body is:

```json
{
  "version": 1,
  "origin": "cold_outreach",
  "brandMode": "outreach_demo",
  "demo_id": "demo_test_123",
  "correlation_id": "video:demo_test_123",
  "image_requests": [{
    "url": "https://forly.example/api/outreach/render-asset",
    "body": {"demo_id":"demo_test_123", "asset_id":"asset_website_123"},
    "headers": {
      "x-forly-timestamp":"1700000000000",
      "x-forly-request-id":"fixture-source-request-123",
      "x-forly-signature":"0000000000000000000000000000000000000000000000000000000000000000"
    }
  }],
  "property_details":{"location":"Test city","property_type":"apartment","rooms":3},
  "callback_url":"https://forly.example/api/video-overlay"
}
```

`image_requests` contains authenticated request instructions, not public image URLs. Immediately after authenticating/accepting the webhook, n8n must POST the exact `body` as JSON to each `url`, forwarding its corresponding supplied headers and adding `Content-Type: application/json`. Each image request is signed with purpose **`source`** and expires within the five-minute clock window. The response is binary image bytes; store them only in private, bounded workflow/provider storage. Never convert these instructions into public `/files` uploads, log their headers, or send them to an image provider as a public URL. Reject redirects; the configured origin and `/api/outreach/render-asset` path are the only permitted source endpoint. The server rechecks demo ownership, active status and manifest rendition. It never returns `clean_paid` through this source endpoint.

Authenticate the inbound pipeline request with the same canonical HMAC implementation. Reject reused request IDs durably. Treat `correlation_id` as the source job identity and preserve it through generation and callback. Acknowledge only after recording durable work ownership. A webhook timeout is `outcome_unknown`, and the server will not blindly replay it: reconcile the existing job before an operator authorizes any new paid render.

Generate clips from the image bytes, then make a **newly signed** POST to `callback_url` with purpose **`overlay`**, fresh timestamp and unique request ID. Do not forward the old pipeline/source signature: it has a different purpose and body. The exact [overlay request](fixtures/overlay-request.v1.json) and [response](fixtures/overlay-response.v1.json) fixtures preserve the demo/correlation IDs. At most six clips and three lines (60 characters per line) are supported. Do not call the ordinary `/createPropertyPage` callback for outreach records. The photo-first page is already active through the outreach domain. The response's renditions contain IDs only; neither includes a URL; response schemas reject extra private paths, source URLs and public clean URLs.

The original distribution render remains a separate `promo_titled` mode; this versioned schema intentionally describes only the outreach contract. Do not add automated Messenger steps to this workflow. The v1 delivery lane remains human-reviewed manual confirmation.

## Container/CI rendering verification

Run the same integration test inside the deployment image to verify the installed ffmpeg build and fonts, from repository root:

```sh
docker build -f server/Dockerfile -t forly-outreach-render-test .
docker run --rm --network none --entrypoint node forly-outreach-render-test server/overlay-outreach.test.js
docker run --rm --network none --entrypoint node forly-outreach-render-test server/overlay.test.js
```

The existing Docker image copies `server/` but not documentation. For the contract fixture test, mount the checked-in docs read-only:

```sh
docker run --rm --network none --volume "$PWD/docs:/app/docs:ro" --entrypoint node forly-outreach-render-test server/outreach/contract.test.js
```

The two render tests need no mounted files or external credentials. CI should run the image build and these tests before merge; they create synthetic black-video fixtures and inspect the central watermark at beginning, middle and end. They do not call generation providers or perform outreach. Firestore emulator and full n8n staging reconciliation remain separate release checks.
