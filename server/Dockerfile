# Forly intake server — run next to n8n on the VPS.
# Build from the repo root so public-agent/ is in context:
#   docker build -f server/Dockerfile -t forly-intake .
#   docker run -d --name forly-intake -p 8787:8787 \
#     -e BASE_URL=https://intake.example.com \
#     -e N8N_WW1_WEBHOOK_URL=https://n8n.srv1173890.hstgr.cloud/webhook/dashboard-create \
#     -e N8N_PIPELINE_WEBHOOK_URL=https://n8n.srv1173890.hstgr.cloud/webhook/property-page-builder \
#     -e GOOGLE_APPLICATION_CREDENTIALS=/secrets/sa-key.json \
#     -v /opt/forly/sa-key.json:/secrets/sa-key.json:ro \
#     -v forly-uploads:/app/server/data/uploads \
#     forly-intake
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/
RUN cd server && npm install --omit=dev
COPY server/ server/
COPY public-agent/ public-agent/
COPY public-nadlan/ public-nadlan/
EXPOSE 8787
CMD ["node", "server/index.js"]
