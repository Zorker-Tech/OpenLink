import { SlateCloudAgentLaunchError } from "./cloud-agent-launch-error.ts";

function pathWithoutGitSuffix(pathname: string): string {
  const path = pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (path.length === 0 || path === "/") return "";
  return path.startsWith("/") ? path : `/${path}`;
}

function repositoryUrlInput(rawUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)) return rawUrl;
  const https = `https://${rawUrl}`;
  try {
    new URL(https);
    return https;
  } catch {
    const scp = /^([^@/\s]+@)?([^:/\s]+):(.+)$/.exec(rawUrl);
    if (scp === null) return https;
    return `ssh://${scp[1] ?? ""}${scp[2]}/${scp[3]}`;
  }
}

function parsedRepositoryUrl(rawUrl: string): URL | undefined {
  try {
    return new URL(repositoryUrlInput(rawUrl));
  } catch {
    return undefined;
  }
}

export function sanitizeRemoteUrl(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) return "";
  const parsed = parsedRepositoryUrl(value);
  return parsed === undefined ? "" : `${parsed.hostname}${pathWithoutGitSuffix(parsed.pathname)}`.toLowerCase();
}

export function sanitizeRemoteUrlForHttpUrl(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) return "";
  const parsed = parsedRepositoryUrl(value);
  if (parsed !== undefined) {
    const protocol = parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.protocol : "https:";
    return `${protocol}//${parsed.host.toLowerCase()}${pathWithoutGitSuffix(parsed.pathname)}`;
  }
  const normalized = sanitizeRemoteUrl(value);
  return normalized.length === 0 ? "" : `https://${normalized}`;
}

export function normalizeRepoReference(ref: string): string {
  const value = ref.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    ? `https://github.com/${value}`
    : value;
}

export function buildRepoFromRemote(remote: string, baseBranch?: string) {
  const normalized = normalizeRepoReference(remote);
  const sanitizedRepoUrl = sanitizeRemoteUrl(normalized);
  const httpRepoUrl = sanitizeRemoteUrlForHttpUrl(normalized);
  if (sanitizedRepoUrl.length === 0 || httpRepoUrl.length === 0) {
    throw new SlateCloudAgentLaunchError(`Slate could not parse the repository '${remote}'.`);
  }
  return { sanitizedRepoUrl, httpRepoUrl, ...(baseBranch === undefined ? {} : { baseBranch }) };
}
