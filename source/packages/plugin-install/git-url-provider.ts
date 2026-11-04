import {
  isAzureDevopsServicesHost,
  isBitbucketCloudHost,
  isGitHubDotComHost,
  isGitLabHost,
  parseGitHubRepositoryPathSegments,
} from "../../adapters/interop/scm/git-host-url-adapter.ts";
import { isOriginGitHost } from "../utils/repo-url.ts";
import type { ParsedGitUrl, ScmProvider } from "./git-url-parsing-contracts.ts";
import { urlFromGitAddress } from "./git-url-normalize.ts";

function providerForHost(hostname: string): ScmProvider {
  if (isGitHubDotComHost(hostname)) return "github";
  if (isGitLabHost(hostname)) return "gitlab";
  if (isBitbucketCloudHost(hostname)) return "bitbucket";
  if (isAzureDevopsServicesHost(hostname)) return "azure_devops";
  return "generic";
}

/** Provider-family hint for hosts that are parsed but not enabled as a source. */
export function unsupportedForgeName(hostname: string): string | null {
  const foldedHost = hostname.toLowerCase();
  if (isGitLabHost(hostname)) return "GitLab";
  if (foldedHost.includes("bitbucket")) return "Bitbucket";
  if (foldedHost.includes("gitea") || foldedHost.includes("codeberg")) return "Gitea/Codeberg";
  if (foldedHost.includes("azure") && foldedHost.includes("dev")) return "Azure DevOps";
  return null;
}

/** Parse the host and first repository path pair from common Git address spellings. */
export function parseGitUrl(gitUrl: string): ParsedGitUrl | null {
  const address = urlFromGitAddress(gitUrl);
  if (address === null) return null;

  const host = address.hostname;
  let route = address.pathname.split("/").filter(Boolean);
  if (isOriginGitHost(host) && route[0]?.toLowerCase() === "git") route = route.slice(1);
  if (route.length >= 3 && route[0]!.toLowerCase() === "scm") route = route.slice(1);
  const repository = parseGitHubRepositoryPathSegments(route);
  if (repository === undefined) return null;
  return { provider: providerForHost(host), owner: repository.owner, repo: repository.repo, host };
}
