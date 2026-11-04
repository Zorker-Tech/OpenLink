/** Route, credential and request-header values owned by Slate's gateway. */
export const SLATE_GATEWAY = {
  paths: {
    api: "/api",
    events: "/events",
    health: "/health",
    avatars: "/avatars",
  },
  authentication: { scheme: "Bearer" },
  headers: {
    slimAvatars: "x-slate-slim-avatars",
    mintDedupe: "x-slate-mint-dedupe",
    traceparent: "traceparent",
    networkToken: "x-slate-network-token",
  },
} as const;
