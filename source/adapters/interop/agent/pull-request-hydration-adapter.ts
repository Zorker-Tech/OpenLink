/**
 * Turning attached pull requests and review diffs into their contents.
 *
 * The attachment names what the user picked; the content is a blob the platform stored when the
 * attachment was made. Both kinds are hydrated the same way — an attachment that already carries its
 * data is left alone, and one that carries a blob id is fetched and decoded — and both throw when the
 * data is not there, because a review attachment with no diff would otherwise be presented as a review
 * of nothing.
 */

import type { Context } from "../../../packages/context/context.ts"
import {
  SelectedGitPRDiffSelection,
  SelectedPullRequest,
  type SelectedGitPRDiffSelection as SelectedGitPRDiffSelectionMessage,
  type SelectedPullRequest as SelectedPullRequestMessage,
} from "../proto/generated/agent/v1/selected_context_pb.ts"
import type {
  SlatePullRequestDiffSelection,
  SlatePullRequestSelection,
} from "../../../packages/agent/context/selected-context-processing-contracts.ts"

export interface PrHydrationBlobStore {
  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined>
}

export interface HydrateSelectedPullRequestsArgs {
  readonly ctx: Context
  readonly selectedPullRequests: readonly SlatePullRequestSelection[]
  readonly blobStore?: PrHydrationBlobStore | undefined
}

export interface HydrateGitPrDiffSelectionsArgs {
  readonly ctx: Context
  readonly gitPrDiffSelections: readonly SlatePullRequestDiffSelection[]
  readonly blobStore?: PrHydrationBlobStore | undefined
}

export function fromInteropSelectedPullRequest(pr: SelectedPullRequestMessage): SlatePullRequestSelection {
  return {
    number: pr.number,
    url: pr.url,
    localReviewDirectory: pr.folderPath,
    ...(pr.title === undefined ? {} : { title: pr.title }),
    ...(pr.summaryJson === undefined ? {} : { summaryDocument: pr.summaryJson }),
    ...(pr.description === undefined ? {} : { description: pr.description }),
    ...(pr.blobId === undefined ? {} : { blobId: new Uint8Array(pr.blobId) }),
  }
}

export function fromInteropSelectedPullRequestDiff(
  selection: SelectedGitPRDiffSelectionMessage,
): SlatePullRequestDiffSelection {
  return {
    url: selection.prUrl,
    filePath: selection.filePath,
    startLine: selection.startLine,
    endLine: selection.endLine,
    ...(selection.diffContent === undefined ? {} : { diff: selection.diffContent }),
    ...(selection.blobId === undefined ? {} : { blobId: new Uint8Array(selection.blobId) }),
  }
}

export async function hydrateSelectedPullRequests({
  ctx,
  selectedPullRequests,
  blobStore,
}: HydrateSelectedPullRequestsArgs): Promise<SlatePullRequestSelection[]> {
  return Promise.all(selectedPullRequests.map(async pr => {
    if (pr.blobId !== undefined && pr.blobId.length > 0) {
      if (!blobStore) throw new Error("Blob store is required to hydrate selected pull request blob")
      const blobData = await blobStore.getBlob(ctx, pr.blobId)
      if (!blobData) throw new Error("Selected pull request blob not found")
      return fromInteropSelectedPullRequest(SelectedPullRequest.fromBinary(blobData))
    }
    return pr
  }))
}

export async function hydrateGitPrDiffSelections({
  ctx,
  gitPrDiffSelections,
  blobStore,
}: HydrateGitPrDiffSelectionsArgs): Promise<SlatePullRequestDiffSelection[]> {
  return Promise.all(gitPrDiffSelections.map(async selection => {
    if (selection.blobId !== undefined && selection.blobId.length > 0) {
      if (!blobStore) throw new Error("Blob store is required to hydrate git PR diff selection blob")
      const blobData = await blobStore.getBlob(ctx, selection.blobId)
      if (!blobData) throw new Error("Git PR diff selection blob not found")
      return fromInteropSelectedPullRequestDiff(SelectedGitPRDiffSelection.fromBinary(blobData))
    }
    return selection
  }))
}
