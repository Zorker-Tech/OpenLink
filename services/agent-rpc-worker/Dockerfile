FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 python3-pip build-essential ca-certificates \
  && corepack enable \
  && corepack prepare pnpm@10.12.4 --activate \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
COPY packages/pi-runtime/tarballs ./packages/pi-runtime/tarballs
COPY services/agent-rpc-worker/package.json services/agent-rpc-worker/package-lock.json ./openlink/agent-rpc-worker/
WORKDIR /opt/openlink/agent-rpc-worker
RUN npm ci --omit=dev --ignore-scripts=false
COPY services/agent-rpc-worker/dist ./dist
COPY services/agent-browser-extension/openlink-browser.ts ./extensions/openlink-browser.ts
COPY services/agent-supabase-extension/openlink-supabase.ts ./extensions/openlink-supabase.ts

ENV NODE_ENV=production
EXPOSE 43131
ENTRYPOINT ["node", "dist/main.js"]
