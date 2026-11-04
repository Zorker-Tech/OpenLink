import assert from "node:assert/strict"
import { test } from "node:test"

import {
  isAzureDevopsServicesHost,
  isBitbucketCloudHost,
  isGitHubDotComHost,
  isGitLabHost,
  parseAzureDevopsRepositoryPathSegments,
  parseBitbucketRepositoryPathSegments,
  parseGitHubRepositoryPathSegments,
  parseGitLabRepositoryPathSegments,
} from "../../source/adapters/interop/scm/git-host-url-adapter.ts"

test("host recognition is case-insensitive and scoped to each supported service", () => {
  assert.equal(isGitHubDotComHost("GIST.GitHub.COM"), true)
  assert.equal(isGitHubDotComHost("github.example"), false)
  assert.equal(isGitLabHost("gitlab.company.test"), true)
  assert.equal(isGitLabHost("code.gitlab.example"), true)
  assert.equal(isBitbucketCloudHost("WWW.BITBUCKET.ORG"), true)
  assert.equal(isBitbucketCloudHost("bitbucket.company.test"), false)
  assert.equal(isAzureDevopsServicesHost("DEV.AZURE.COM"), true)
  assert.equal(isAzureDevopsServicesHost("dev.azure.com.evil.test"), false)
})

test("the owner/repository form strips a terminal suffix and notes remaining route parts", () => {
  assert.deepEqual(parseGitHubRepositoryPathSegments(["acme", "widgets.GIT", "tree", "main"]), {
    owner: "acme",
    repo: "widgets",
    hasSubpath: true,
  })
  assert.equal(parseGitHubRepositoryPathSegments(["acme"]), undefined)
  assert.equal(parseGitHubRepositoryPathSegments(["acme", ".git"]), undefined)
})

test("nested namespaces stop at the special route separator", () => {
  assert.deepEqual(parseGitLabRepositoryPathSegments(["team", "platform", "widgets.git", "-", "issues"]), {
    repositorySegments: ["team", "platform", "widgets"],
    hasSpecialRouteSeparator: true,
  })
  assert.deepEqual(parseGitLabRepositoryPathSegments(["team", "platform", "widgets"]), {
    repositorySegments: ["team", "platform", "widgets"],
    hasSpecialRouteSeparator: false,
  })
  assert.equal(parseGitLabRepositoryPathSegments(["team", "-", "issues"]), undefined)
})

test("encoded workspace names round-trip safely and account roots are rejected", () => {
  assert.deepEqual(parseBitbucketRepositoryPathSegments(["team%20space", "widget%20lib.git", "src"]), {
    workspace: "team%20space",
    repo: "widget%20lib",
    hasSubpath: true,
  })
  assert.equal(parseBitbucketRepositoryPathSegments(["account", "profile"]), undefined)
  assert.equal(parseBitbucketRepositoryPathSegments(["team%2Fother", "repo"]), undefined)
  assert.equal(parseBitbucketRepositoryPathSegments(["team", "%E0%A4%A"]), undefined)
})

test("the project and repository are separated by the service route marker", () => {
  assert.deepEqual(parseAzureDevopsRepositoryPathSegments(["acme", "studio", "_git", "widgets.git", "pull"]), {
    organization: "acme",
    project: "studio",
    repo: "widgets",
    hasSubpath: true,
  })
  assert.deepEqual(parseAzureDevopsRepositoryPathSegments(["acme", "_git", "widgets"]), {
    organization: "acme",
    project: "widgets",
    repo: "widgets",
    hasSubpath: false,
  })
  assert.equal(parseAzureDevopsRepositoryPathSegments(["acme", "studio", "widgets"]), undefined)
})
