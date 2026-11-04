import {
  isAzureDevopsServicesHost,
  isBitbucketCloudHost,
  isGitHubDotComHost,
  isGitLabHost,
  parseAzureDevopsRepositoryPathSegments,
  parseBitbucketRepositoryPathSegments,
  parseGitLabRepositoryPathSegments,
} from "../../adapters/interop/scm/git-host-url-adapter.ts";
import { isOriginGitHost } from "../utils/repo-url.ts";
import type { ParsedGitUrl, ScmRepository, ScmUrlResult } from "./git-url-parsing-contracts.ts";
import { unsupportedForgeName, parseGitUrl } from "./git-url-provider.ts";
import { urlFromGitAddress } from "./git-url-normalize.ts";

function hasServerScmRoute(address: string): boolean {
  const parsed = urlFromGitAddress(address);
  if (parsed === null) return false;
  const route = parsed.pathname.split("/").filter(Boolean);
  return route.length >= 3 && route[0]!.toLowerCase() === "scm";
}

function bitbucketRepositoryRoute(parsed: URL): string[] {
  const route = parsed.pathname.split("/");
  if (route[0] === "") route.shift();
  if (route[route.length - 1] === "") route.pop();
  return route;
}

function parseBitbucketCloudAddress(address: string) {
  const parsed = urlFromGitAddress(address.trim());
  if (parsed === null || !isBitbucketCloudHost(parsed.hostname)) return undefined;
  return parseBitbucketRepositoryPathSegments(bitbucketRepositoryRoute(parsed));
}

function acceptsGitHubCompatibleHost(repository: ParsedGitUrl): boolean {
  switch (repository.provider) {
    case "github":
      return true;
    case "generic":
      return !isOriginGitHost(repository.host) && unsupportedForgeName(repository.host) === null;
    case "gitlab":
    case "bitbucket":
    case "azure_devops":
      return false;
  }
}

/** Normalize a supported repository into the HTTPS identity used by plugin records. */
export function parseAndValidateScmUrl(input: string): ScmUrlResult {
  const candidate = input.trim();
  if (candidate === "") return { error: "URL cannot be empty" };

  const repository = parseGitUrl(candidate);
  if (repository === null) {
    return { error: "Invalid URL format. Expected: github.com/owner/repo or gitlab.com/namespace/repo" };
  }

  if (isGitLabHost(repository.host)) {
    const parsed = urlFromGitAddress(candidate);
    const route = parsed === null ? undefined : parseGitLabRepositoryPathSegments(parsed.pathname.split("/").filter(Boolean));
    if (parsed === null || route === undefined) {
      return { error: "Invalid GitLab repository URL format. Expected: https://gitlab.com/namespace/repo" };
    }
    const host = parsed.host.replace(/^www\./i, "");
    const namespacePath = route.repositorySegments.join("/");
    return {
      url: `https://${host}/${namespacePath}`,
      owner: route.repositorySegments[0]!,
      repo: route.repositorySegments[route.repositorySegments.length - 1]!,
      host,
      provider: "gitlab",
    };
  }

  if (repository.provider === "bitbucket") {
    const route = parseBitbucketCloudAddress(candidate);
    if (route === undefined) {
      return { error: "Invalid Bitbucket repository URL format. Expected: https://bitbucket.org/{workspace}/{repo}" };
    }
    const host = repository.host.replace(/^www\./i, "");
    return {
      url: `https://${host}/${route.workspace}/${route.repo}`,
      owner: route.workspace,
      repo: route.repo,
      host,
      provider: "bitbucket",
    };
  }

  if (repository.provider === "azure_devops") {
    const parsed = urlFromGitAddress(candidate);
    const route = parsed === null ? undefined : parseAzureDevopsRepositoryPathSegments(parsed.pathname.split("/").filter(Boolean));
    if (parsed === null || route === undefined) {
      return { error: "Invalid Azure DevOps repository URL format. Expected: https://dev.azure.com/{organization}/{project}/_git/{repo}" };
    }
    const host = repository.host.replace(/^www\./i, "");
    return {
      url: `https://${host}/${route.organization}/${route.project}/_git/${route.repo}`,
      owner: route.organization,
      repo: route.repo,
      host,
      provider: "azure_devops",
      project: route.project,
    };
  }

  if (acceptsGitHubCompatibleHost(repository)) {
    const host = canonicalRepoHost(repository.host.replace(/^www\./i, ""));
    const pathPrefix = hasServerScmRoute(candidate) ? "scm/" : "";
    return {
      url: `https://${host}/${pathPrefix}${repository.owner}/${repository.repo}`,
      owner: repository.owner,
      repo: repository.repo,
      host,
      provider: "github",
    };
  }

  const unsupported = unsupportedForgeName(repository.host);
  return {
    error: `Only GitHub, GitLab, Bitbucket, and Azure DevOps URLs are currently supported.${unsupported !== null ? ` ${unsupported} is not supported yet.` : ""}`,
  };
}

/** Rewrite an enabled SCM URL to the canonical HTTPS-style SSH form where supported. */
export function toScmSshUrl(gitUrl: string): string | null {
  const repository = parseAndValidateScmUrl(gitUrl);
  if ("error" in repository) return null;
  switch (repository.provider) {
    case "github":
      return `git@${repository.host}:${repository.owner}/${repository.repo}.git`;
    case "gitlab":
      return gitlabSshAddress(repository);
    case "bitbucket":
    case "azure_devops":
      return null;
  }
}

function gitlabSshAddress(repository: ScmRepository): string | null {
  let pathname: string;
  try {
    pathname = new URL(repository.url).pathname.replace(/^\//, "").replace(/\.git$/i, "");
  } catch {
    return null;
  }
  if (pathname.length === 0) return null;
  return `git@${repository.host.replace(/:\d+$/, "")}:${pathname}.git`;
}

export function canonicalRepoHost(host: string): string {
  return isGitHubDotComHost(host) ? "github.com" : host;
}
