import type { BotBlockCondition, BotBlockPage, BotBlockSignature } from "./bot-block-contracts.ts";

export function matchesHost(condition: BotBlockCondition, hostname: string): boolean {
  return condition.equals?.includes(hostname) === true
    || condition.suffix?.some((suffix) => hostname.endsWith(suffix)) === true;
}

export function matchesPath(condition: BotBlockCondition, pathname: string): boolean {
  return condition.equals?.includes(pathname) === true
    || condition.prefix?.some((prefix) => pathname.startsWith(prefix)) === true
    || condition.includes?.some((part) => pathname.includes(part)) === true;
}

export function matchesTitle(condition: BotBlockCondition, title: string): boolean {
  return condition.equals?.includes(title) === true
    || condition.startsWith?.some((prefix) => title.startsWith(prefix)) === true;
}

export function matchesBotBlockSignature(signature: BotBlockSignature, page: BotBlockPage): boolean {
  return (signature.host === undefined || matchesHost(signature.host, page.hostname))
    && (signature.path === undefined || matchesPath(signature.path, page.pathname))
    && (signature.title === undefined || matchesTitle(signature.title, page.title));
}
