import type { BotBlockSignature } from "./bot-block-contracts.ts";

export const BOT_BLOCK_SIGNATURES: readonly BotBlockSignature[] = [
  { family: "google_sorry", confidence: "high", host: { equals: ["google.com"], suffix: [".google.com"] }, path: { prefix: ["/sorry"] } },
  { family: "google_signin_rejected", confidence: "high", host: { equals: ["accounts.google.com"] }, path: { includes: ["/signin/rejected"] } },
  { family: "google_device_redirect", confidence: "high", host: { equals: ["g.co"] }, path: { equals: ["/sc"], prefix: ["/sc/"] } },
  { family: "recaptcha", confidence: "low", path: { includes: ["/recaptcha/api2/", "/recaptcha/enterprise/"] } },
  { family: "cloudflare_challenge", confidence: "high", path: { includes: ["/cdn-cgi/challenge-platform/"] } },
  { family: "cloudflare_challenge", confidence: "high", host: { equals: ["challenges.cloudflare.com"] } },
  { family: "cloudflare_challenge", confidence: "high", title: { startsWith: ["Just a moment", "Attention Required! | Cloudflare"] } },
  { family: "hcaptcha", confidence: "low", host: { equals: ["hcaptcha.com"], suffix: [".hcaptcha.com"] } },
  { family: "arkose", confidence: "high", host: { suffix: [".arkoselabs.com", ".funcaptcha.com"] } },
  { family: "linkedin_checkpoint", confidence: "high", host: { equals: ["linkedin.com"], suffix: [".linkedin.com"] }, path: { prefix: ["/checkpoint/challenge"] } },
  { family: "datadome", confidence: "high", host: { equals: ["captcha-delivery.com", "captcha.datadome.co"], suffix: [".captcha-delivery.com"] } },
  { family: "perimeterx", confidence: "high", path: { includes: ["/px/captcha"] } },
  { family: "perimeterx", confidence: "high", host: { equals: ["captcha.px-cdn.net"], suffix: [".px-cloud.net"] } },
  { family: "perimeterx", confidence: "high", title: { equals: ["Access to this page has been denied"] } },
  { family: "imperva", confidence: "high", path: { includes: ["/_Incapsula_Resource"] } },
  { family: "distil", confidence: "high", title: { equals: ["Pardon Our Interruption"] } },
  { family: "aws_waf", confidence: "high", host: { suffix: [".token.awswaf.com"] } },
  { family: "vercel_checkpoint", confidence: "high", title: { startsWith: ["Vercel Security Checkpoint"] } },
  { family: "vercel_checkpoint", confidence: "high", path: { includes: ["/.well-known/vercel/security/"] } },
  { family: "generic_access_denied", confidence: "low", title: { equals: ["Access Denied"] } },
];
