# Rules for Claude in this project

## Production-touching actions require EXPLICIT per-action approval

Never run any of the following without an explicit "yes do that" from the user
*for that specific run*. Past approval for a previous deploy does NOT carry
over — every deploy needs its own confirmation.

- `firebase deploy …` (any target: functions, hosting, storage, firestore)
- `firebase hosting:channel:deploy …`
- `git push …` (any remote, any branch, any flag)
- `gcloud ... add-iam-policy-binding` or any IAM mutation
- `gcloud functions deploy …`, `gcloud run deploy …`
- `npm publish`, `npm version`
- Creating/deleting Firestore docs in production via scripts
- Anything that modifies the production Cloud Functions, Hosting, Storage,
  Firestore, IAM policies, or secrets

Local-only actions are fine without confirmation: editing files, running
`npm run build`, running `firebase emulators:start`, `curl` against localhost,
TypeScript builds, etc.

## How to ship

When code is ready to deploy:
1. Tell the user *exactly* which command will run.
2. Wait for an explicit "yes" / "deploy" / "do it" before running.
3. After the user approves, run the deploy.

Pattern to avoid: "fix → silent deploy". Always pause and ask.

## Other notes

- Local dev uses Node 22 via the project's `.nvmrc`.
- Local emulator authenticates with `functions/sa-key.local.json` via
  `GOOGLE_APPLICATION_CREDENTIALS` in `functions/.env.local`. Don't commit either.
- Secrets `GREENAPI_INSTANCE` and `GREENAPI_TOKEN` live in
  `functions/.secret.local` for the emulator and in Google Secret Manager for prod.
