FROM node:24-bookworm-slim

# Keep the project VM's session environments useful for real coding work. The
# workspace is mounted at runtime, while the executable toolchain belongs to
# this immutable worker image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 python3-pip build-essential ca-certificates \
  && corepack enable \
  && corepack prepare pnpm@10.12.4 --activate \
  && rm -rf /var/lib/apt/lists/*

# Codex CLI ships the `codex app-server` binary the OpenLink Codex runtime
# speaks to. The npm package resolves the native binary for the target arch.
RUN npm install -g @openai/codex@latest && codex --version

WORKDIR /opt

COPY packages/pi-runtime/tarballs ./packages/pi-runtime/tarballs
COPY services/agent-worker/package.json services/agent-worker/package-lock.json ./openlink/agent-worker/
WORKDIR /opt/openlink/agent-worker
RUN npm ci --omit=dev --ignore-scripts=false

COPY services/agent-worker/dist ./dist
COPY services/agent-browser-extension/openlink-browser.ts ./extensions/openlink-browser.ts
COPY services/agent-supabase-extension/openlink-supabase.ts ./extensions/openlink-supabase.ts

ENV NODE_ENV=production
EXPOSE 43130
ENTRYPOINT ["node", "dist/main.js"]
