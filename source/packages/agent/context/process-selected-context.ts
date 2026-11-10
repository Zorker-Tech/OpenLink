/**
 * Everything the user sent with a turn, turned into what the model is given.
 *
 * This is the largest assembly in the agent: the images, videos and documents attached to a message; the
 * invocation the turn came from; the code selections, terminals and folders; the links that have to be
 * fetched; the documentation; the pull requests; the rules and skills the user attached; and the
 * instructions for a wake-up the user did not write. What makes it more than a list is the shape of the
 * work: the attachments are hydrated together, then the enrichment tasks that need the network or the blob
 * store run one after another, and only then is everything assembled in the order the model should read it.
 * Each phase is measured, because the time before the first token is the number users feel, and the
 * measurements name the sub-task that did work rather than only how long the whole thing took.
 *
 * Three decisions run through it. What is small enough to inline and what has to be written to a file and
 * referred to by path: a link that returns a page, a code selection that runs long, a video a subagent will
 * read from disk — each has a limit above which the content goes to the workspace instead of the message.
 * What is the user's and what is the platform's: a rule or a skill attached by hand is counted as applied
 * so the platform knows it was used, and an image already inside the workspace is used where it is rather
 * than copied. And what may be attached at all: a video for a model that cannot watch one, or in a session
 * whose privacy mode forbids storing media, is refused by the leaf that handles it rather than quietly
 * dropped here.
 *
 * A failure in one attachment does not fail the turn. Writing a fetched page to a file that the session
 * cannot write leaves the content inline instead, and a document that cannot be materialised is dropped,
 * because a turn that is missing one attachment is better than a turn that does not start.
 */

import type { Context } from "../../context/context.ts"
import { createLogger } from "../../context/index.ts"
import { createHistogram } from "../../metrics/index.ts"
import type { BlobStore } from "../../agent-kv/blob-store.ts"
import { writeWorkspaceBytesThroughInterop, type InteropWorkspaceFileWriteAccessor } from "../../../adapters/interop/agent/workspace-file-write-adapter.ts"
import type { SlateSelectedContextForProcessing } from "./selected-context-processing-contracts.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import { AgentType } from "../utils/agent-config.ts"
import { getFilenameWithoutExtension } from "../utils/common-helpers.ts"
import { classifyInteropSkillSourcePath } from "../../../adapters/interop/agent/skill-source-path-adapter.ts"
import { getSkillIdFromPath } from "../skill-id.ts"
import { recordSkillApplied } from "../utils/event-tracking.ts"
import { getInlineVideoMaxBytes, getSignedUrlVideoMaxBytes, isSignedUrlStorageAllowed } from "../attached-media.ts"
import { detectImageMimeType } from "../tools/core/read/image-utils.ts"
import { renderAgentNotesContext } from "./agent-notes-context.ts"
import { renderSelectedCodeSelections } from "./code-selection-context.ts"
import { renderConsoleLogsContext } from "./console-logs-context.ts"
import { processSlateDocumentAttachment } from "../../../adapters/interop/agent/document-attachment-adapter.ts"
import { hydrateDocumentation, type DocumentationHydrationService } from "./documentation-hydration.ts"
import { renderDocumentationContext, type DocumentationResult } from "./documentation-context.ts"
import { hydrateSelectedExtraContext } from "./extra-context-hydration.ts"
import { renderExternalLinksContext } from "./external-links-context.ts"
import { renderAttachedFoldersContext } from "./attached-folders-context.ts"
import { hydrateSlateImage } from "./image-attachment-hydration.ts"
import type { SlateImageAttachment } from "./image-attachment-contracts.ts"
import { writeSelectedImageToProjectAssets } from "./image-file-spill.ts"
import { resolveSlateInvocationSelection } from "../../../adapters/interop/agent/selected-invocation-context-hydration-adapter.ts"
import { renderInvocationPlatformContext } from "./invocation-platforms.ts"
import { renderManuallyAttachedSkillsSection } from "../manually-attached-skills.ts"
import { appendNonMediaSelectedContextContent } from "./non-media-assembly.ts"
import { hydrateGitPrDiffSelections, hydrateSelectedPullRequests } from "../../../adapters/interop/agent/pull-request-hydration-adapter.ts"
import { createPullRequestPromptInputs } from "./pull-request-prompt.ts"
import { renderPrReviewContext, toPrReviewInputs } from "./pr-review-context.ts"
import { renderRecentAgentsContext } from "./recent-agents-context.ts"
import { resolveSkillAttachments } from "../skill-attachment-policy.ts"
import { renderSelectedBrowsersContext } from "./selected-browsers-context.ts"
import { renderSelectedSubagentDelegation } from "./selected-subagents-context.ts"
import { renderSelectedTerminalContext } from "./terminal-context.ts"
import { renderSelectedUIElementsContext } from "./ui-elements-context.ts"
import { renderUploadedDocumentsContext } from "./uploaded-documents.ts"
import { processSlateVideoAttachment } from "../../../adapters/interop/agent/video-attachment-adapter.ts"
import { enrichExternalLinks, type ExternalLinkPage } from "./external-link-enrichment.ts"
import { processSlateVideoPathOnlyAttachment } from "./video-path-processing.ts"
import type { SlateVideoAttachment } from "./video-attachment-contracts.ts"
import type { SlateDocumentAttachment } from "./document-attachment-contracts.ts"
import { canUseWatchVideoSubagent } from "./watch-video-eligibility.ts"
import { backgroundSourceForVideoPolicy } from "../../../adapters/interop/agent/watch-video-eligibility-adapter.ts"
import type { AttachmentPathRequestContext } from "./path-trust.ts"
import type { AttachedMediaUrlProvider } from "./video-attachment.ts"
import type { CodeSelectionFormattingOptions } from "./code-selection-context.ts"
import type { TaskToolModelInfo } from "../tools/task-tool-name.ts"
import { SlateMode } from "../mode-processing.ts"

interface TextPart { readonly type: "text"; readonly text: string }
interface ImagePart {
  readonly type: "image";
  readonly image: Uint8Array | string | URL;
  readonly mimeType: string;
  readonly providerOptions?: { readonly slate: { readonly mimeType?: string; readonly videoFps?: number } };
}
type UserContentPart = TextPart | ImagePart;

type ResourceAccessor = InteropWorkspaceFileWriteAccessor

interface ProcessRequestContext extends AttachmentPathRequestContext {
  readonly conversationNotesListing?: string;
  readonly sharedNotesListing?: string;
}

interface ContextProcessingConfig {
  readonly enableTerminalFiles: boolean;
  readonly enableAgentNotes: boolean;
  readonly enableImageFiles: boolean;
  readonly enableLongCodeSelectionSpillToFile: boolean;
  readonly formattingOptions: CodeSelectionFormattingOptions;
  readonly agentType?: AgentType;
  readonly backgroundAgentSource?: unknown;
  readonly modelInfo?: TaskToolModelInfo & {
    readonly isLegacyAgentMatterhorn?: boolean;
    readonly isRawTrainingSlug?: boolean;
  };
  readonly conversationId?: string;
  readonly attachedMediaUrlProvider?: AttachedMediaUrlProvider;
  readonly featureFlags?: {
    readonly metaAgentNotes?: boolean;
    readonly dropCustomPromptContext?: boolean;
    readonly environmentParamForSubagent?: boolean;
    readonly babysitV2Prompt?: boolean;
    readonly prCreationForgeGuidance?: boolean;
    readonly enableBackgroundVideoAttachments?: boolean;
    readonly enableWatchVideoInIdeSubagent?: boolean;
    readonly videoAttachmentInlineMaxBytes?: number;
    readonly videoAttachmentSignedUrlMaxBytes?: number;
  };
  readonly webScraperService: {
    getContentInWebsiteFast(ctx: Context, url: string): Promise<ExternalLinkPage | null>;
  };
  readonly documentationHydrationService: DocumentationHydrationService<DocumentationResult>;
}

const logger = createLogger("agent/context-processing");
const enrichContextDuration = createHistogram("agent.ttft.enrichContextMs", {
  description: "Time for the parallelizable context enrichment tasks in processSelectedContext (external links, documentation, PR hydration, etc.)",
});
const enrichContextExternalLinksDuration = createHistogram("agent.ttft.enrichContext.externalLinksMs", {
  description: "Time for the external links enrichment sub-task", labelNames: ["hasWork"],
});
const enrichContextDocumentationDuration = createHistogram("agent.ttft.enrichContext.documentationMs", {
  description: "Time for the documentation hydration sub-task", labelNames: ["hasWork"],
});
const enrichContextBlobStoreDuration = createHistogram("agent.ttft.enrichContext.blobStoreMs", {
  description: "Time for the blob store hydration sub-task (PRs, diffs, extra context)", labelNames: ["hasWork"],
});
const enrichContextActiveTaskCount = createHistogram("agent.ttft.enrichContext.activeTaskCount", {
  description: "Number of enrichment sub-tasks that had actual work to do (0-3).",
});
const blobHydrationDuration = createHistogram("agent.ttft.blobHydrationMs", {
  description: "Time for the pre-enrichment Promise.all that hydrates images, videos, documents, and human changes",
  labelNames: ["hasImages", "hasVideos", "hasDocs"],
});
const invocationContextDuration = createHistogram("agent.ttft.invocationContextMs", {
  description: "Time to hydrate and process invocation context (conversation thread, pull request, editor state)", labelNames: ["kind"],
});
const processSelectedContextDuration = createHistogram("agent.ttft.processSelectedContextMs", {
  description: "Total wall-clock time for the entire processSelectedContext function",
});
const postEnrichmentAssemblyDuration = createHistogram("agent.ttft.postEnrichmentAssemblyMs", {
  description: "Time for sync context assembly after enrichment (rules, skills, git diffs, PRs, etc.)",
});
const MAX_RULE_LENGTH = 100_000;

export async function processSelectedContext(
  ctx: Context,
  selectedContext: SlateSelectedContextForProcessing,
  blobStore: BlobStore<Context> | undefined,
  config: ContextProcessingConfig,
  requestContext: ProcessRequestContext | undefined,
  resourceAccessor: ResourceAccessor | undefined,
  mode: SlateMode,
  _modelId: string | undefined,
  conversationQuery: string,
  privacyMode: PrivacyMode,
): Promise<{
  userContent: UserContentPart[];
  selectedImages: SlateImageAttachment[];
  selectedVideos: SlateVideoAttachment[];
  selectedDocuments: SlateDocumentAttachment[];
  imageFilePaths: string[];
  videoFilePaths: string[];
  documentFilePaths: string[];
}> {
  const userContent: UserContentPart[] = [];
  const selectedImages: SlateImageAttachment[] = [];
  const selectedVideos: SlateVideoAttachment[] = [];
  const selectedDocuments: SlateDocumentAttachment[] = [];
  const workspaceSelection = selectedContext.workspace
  const imageAttachments = selectedContext.images
  const videoAttachments = selectedContext.videos
  const documentAttachments = selectedContext.documents
  const imageFilePaths: string[] = [];
  const videoFilePaths: string[] = [];
  const documentFilePaths: string[] = [];
  const processStart = performance.now();

  const invocationStart = performance.now();
  const invocation = await resolveSlateInvocationSelection({
    ctx,
    selection: selectedContext.invocation,
    blobStore,
  });
  if (invocation !== undefined) {
    const invocationContent = renderInvocationPlatformContext(invocation, config.enableTerminalFiles)
    if (invocationContent) userContent.push(invocationContent);
  }
  invocationContextDuration.histogram(ctx, performance.now() - invocationStart, {
    kind: invocation === undefined || invocation.kind === "unsupported" ? "none" : invocation.kind,
  });
  const agentNotes = renderAgentNotesContext({
    isProjectConversation: mode === SlateMode.PROJECT,
    enableAgentNotes: config.enableAgentNotes,
    metaAgentNotes: config.featureFlags?.metaAgentNotes === true,
    conversationNotesListing: requestContext?.conversationNotesListing,
    sharedNotesListing: requestContext?.sharedNotesListing,
  });
  if (agentNotes) userContent.push(agentNotes);

  const hasImages = imageAttachments.length > 0;
  const hasVideos = videoAttachments.length > 0;
  const hasDocs = documentAttachments.length > 0;
  const blobHydrationStart = performance.now();
  const imageProcessingPromise = Promise.all(imageAttachments.map(async (selectedImage, index) => {
    const hydrated = await hydrateSlateImage({ ctx, blobStore: blobStore!, image: selectedImage });
    const mimeType = selectedImage.mediaType.trim() || (hydrated.imageData ? detectImageMimeType(hydrated.imageData, selectedImage.sourcePath) : undefined) || "image/png";
    const imageFilePath = writeSelectedImageToProjectAssets({
      ctx,
      imageData: hydrated.imageData,
      selectedImage,
      resolvedMimeType: mimeType,
      index,
      enableImageFiles: config.enableImageFiles,
      requestContext,
      resourceAccessor,
    });
    return { image: hydrated.image, imageData: hydrated.imageData, mimeType, imageFilePath };
  }));
  const videoProcessingPromise = Promise.all(videoAttachments.map(async (selectedVideo, index) => {
    const pathOnly = await processSlateVideoPathOnlyAttachment({ ctx, video: selectedVideo, requestContext });
    if (pathOnly !== undefined) return pathOnly;
    const useSignedUrl = !selectedVideo.writeToWorkspace &&
      isSignedUrlStorageAllowed(privacyMode) && config.attachedMediaUrlProvider !== undefined;
    return processSlateVideoAttachment({
      ctx,
      blobStore: blobStore!,
      selectedVideo,
      index,
      modelId: _modelId,
      maxVideoBytes: useSignedUrl
        ? getSignedUrlVideoMaxBytes(createAttachedMediaConfig(config))
        : getInlineVideoMaxBytes(createAttachedMediaConfig(config)),
      requestContext,
      resourceAccessor,
      privacyMode,
      ...(config.attachedMediaUrlProvider === undefined ? {} : { attachedMediaUrlProvider: config.attachedMediaUrlProvider }),
      ...(config.conversationId === undefined ? {} : { conversationId: config.conversationId }),
    });
  }));
  const documentProcessingPromise = Promise.all(documentAttachments.map((selectedDocument, index) => processSlateDocumentAttachment({
    ctx,
    blobStore,
    selectedDocument,
    index,
    requestContext,
    resourceAccessor,
  })));
  const [imageResults, videoResults, documentResults] = await Promise.all([
    imageProcessingPromise,
    videoProcessingPromise,
    documentProcessingPromise,
  ]);
  blobHydrationDuration.histogram(ctx, performance.now() - blobHydrationStart, {
    hasImages: hasImages ? "true" : "false",
    hasVideos: hasVideos ? "true" : "false",
    hasDocs: hasDocs ? "true" : "false",
  });

  const allDocumentInfos: Array<{ readonly path: string }> = [];
  const allVideoInfos: Array<{ readonly path: string }> = [];
  for (const result of imageResults) {
    if (result.image) selectedImages.push(result.image);
    if (result.imageFilePath) imageFilePaths.push(result.imageFilePath);
    if (result.imageData) userContent.push({ type: "image", image: new Uint8Array(result.imageData), mimeType: result.mimeType });
  }
  for (const result of videoResults) {
    if (result.processedVideo) selectedVideos.push(result.processedVideo);
    if (result.localFilePath) {
      videoFilePaths.push(result.localFilePath);
      allVideoInfos.push({ path: result.localFilePath });
    }
    if ("videoUrl" in result && result.videoUrl) {
      userContent.push({
        type: "image",
        image: new URL(result.videoUrl),
        mimeType: result.mimeType,
        providerOptions: { slate: { mimeType: result.mimeType, ...(result.fps === undefined ? {} : { videoFps: result.fps }) } },
      });
    } else if (result.videoData) {
      userContent.push({
        type: "image",
        image: `data:${result.mimeType};base64,${Buffer.from(result.videoData).toString("base64")}`,
        mimeType: result.mimeType,
        ...(result.fps === undefined ? {} : { providerOptions: { slate: { videoFps: result.fps } } }),
      });
    }
  }
  for (const result of documentResults) {
    if (result.selectedDocument) selectedDocuments.push(result.selectedDocument);
    if (result.documentFilePath) {
      documentFilePaths.push(result.documentFilePath);
      allDocumentInfos.push({ path: result.documentFilePath });
    }
  }

  const renderedCodeSelections = await renderSelectedCodeSelections({
    ctx,
    codeSelections: workspaceSelection.codeSelections,
    formattingOptions: config.formattingOptions,
    enableLongCodeSelectionSpillToFile: config.enableLongCodeSelectionSpillToFile,
    requestContext,
    resourceAccessor,
  });
  allDocumentInfos.push(...renderedCodeSelections.documentInfos);
  const attachedFilesContent = [...renderedCodeSelections.attachedFilesContent];
  attachedFilesContent.push(...renderSelectedTerminalContext(workspaceSelection.terminals, workspaceSelection.terminalSelections, config.formattingOptions));
  const attachedFoldersText = renderAttachedFoldersContext(workspaceSelection.folders);
  if (attachedFoldersText) attachedFilesContent.push({ type: "text", text: attachedFoldersText });
  if (attachedFilesContent.length > 0) {
    userContent.push({ type: "text", text: `<attached_files>\n${attachedFilesContent.map(part => part.text).join("\n")}\n</attached_files>` });
  }

  const hasExternalLinks = selectedContext.externalLinkUrls.length > 0;
  const hasDocumentation = selectedContext.documentReferences.length > 0;
  const hasBlobStoreWork = selectedContext.pullRequests.length > 0 || selectedContext.pullRequestDiffs.length > 0 || selectedContext.extraContextEntries.length > 0 || selectedContext.extraContextText.length > 0;
  const enrichStart = performance.now();
  const externalStart = performance.now();
  const externalResult = await enrichExternalLinks({
    urls: selectedContext.externalLinkUrls,
    fetchPage: url => config.webScraperService.getContentInWebsiteFast(ctx, url),
    ...(requestContext?.env?.projectFolder === undefined && requestContext?.env?.workspacePaths?.[0] === undefined
      ? {}
      : { workspaceRoot: requestContext.env?.projectFolder ?? requestContext.env?.workspacePaths?.[0] }),
    ...(resourceAccessor === undefined ? {} : {
      writeFile: (filePath, bytes) => writeWorkspaceBytesThroughInterop(resourceAccessor, ctx, filePath, bytes),
    }),
    onWriteFailure: (url, error) => logger.warn(ctx, "Failed to write external link content to file", {
      url,
      error: error instanceof Error ? error.message : String(error),
    }),
  });
  enrichContextExternalLinksDuration.histogram(ctx, performance.now() - externalStart, { hasWork: hasExternalLinks ? "true" : "false" });
  const documentationStart = performance.now();
  const documentationResult = await hydrateDocumentation(ctx, selectedContext.documentReferences, config.documentationHydrationService, conversationQuery);
  enrichContextDocumentationDuration.histogram(ctx, performance.now() - documentationStart, { hasWork: hasDocumentation ? "true" : "false" });
  const blobStart = performance.now();
  const hydratedSelectedPullRequests = await hydrateSelectedPullRequests({ ctx, selectedPullRequests: selectedContext.pullRequests, blobStore });
  const pullRequestPrompts = createPullRequestPromptInputs(hydratedSelectedPullRequests);
  const hydratedGitPrDiffSelections = await hydrateGitPrDiffSelections({ ctx, gitPrDiffSelections: selectedContext.pullRequestDiffs, blobStore });
  const extraContextsToInclude = await hydrateSelectedExtraContext(ctx, {
    entries: selectedContext.extraContextEntries,
    inlineText: selectedContext.extraContextText,
  }, blobStore);
  enrichContextBlobStoreDuration.histogram(ctx, performance.now() - blobStart, { hasWork: hasBlobStoreWork ? "true" : "false" });
  enrichContextActiveTaskCount.histogram(ctx, Number(hasExternalLinks) + Number(hasDocumentation) + Number(hasBlobStoreWork));
  enrichContextDuration.histogram(ctx, performance.now() - enrichStart);

  const postEnrichmentStart = performance.now();
  for (const document of externalResult.documents) { documentFilePaths.push(document.path); allDocumentInfos.push(document); }
  for (const image of externalResult.images) userContent.push({ type: "image", image: image.imageBytes, mimeType: image.mimeType });
  const externalText = renderExternalLinksContext(externalResult.links);
  if (externalText) userContent.push({ type: "text", text: externalText });
  const uploadedDocumentsText = renderUploadedDocumentsContext(allDocumentInfos);
  if (uploadedDocumentsText) userContent.push({ type: "text", text: uploadedDocumentsText });
  if (allVideoInfos.length > 0) {
    const videosList = allVideoInfos.map(video => `- ${video.path}`).join("\n");
    const watch = canUseWatchVideoSubagent({
      agentType: config.agentType,
      backgroundAgentSource: backgroundSourceForVideoPolicy(config.backgroundAgentSource),
      featureFlags: config.featureFlags,
    })
      ? " You can watch them using your WatchVideo subagent." : "";
    userContent.push({ type: "text", text: `<attached_videos>\nThe following videos have been attached by the user and saved to your filesystem.${watch}\n${videosList}\n</attached_videos>` });
  }
  const documentationText = renderDocumentationContext(documentationResult);
  if (documentationText) userContent.push({ type: "text", text: documentationText });
  const { skills: selectedSkills, rules: regularRules } = resolveSkillAttachments(selectedContext.skillAttachments);
  const dropCustomPromptContext = config.featureFlags?.dropCustomPromptContext === true;
  if (!dropCustomPromptContext && regularRules.length > 0) {
    const rulesText = regularRules.map(rule => `Rule Name: ${rule.path ? getFilenameWithoutExtension(rule.path) : "Workspace Rule"}\nDescription: ${rule.text?.slice(0, MAX_RULE_LENGTH) ?? ""}`).join("\n\n");
    userContent.push({ type: "text", text: `<workspace_rules_context>\nProject rules are supplemental context supplied with the workspace.\nUse each rule only when it helps answer the current request.\n\n${rulesText}\n</workspace_rules_context>\n` });
  }
  if (!dropCustomPromptContext && selectedSkills.length > 0) {
    const attachedSkills = selectedSkills;
    const seen = new Set<string>();
    for (const skill of attachedSkills) {
      const path = skill.path.trim();
      if (!path || seen.has(path)) continue;
      seen.add(path);
      recordSkillApplied(ctx, {
        entrypoint: "manually_attached",
        skillId: getSkillIdFromPath(path),
        skillSource: classifyInteropSkillSourcePath(path),
        ...(typeof skill.pluginName === "string" ? { plugin: skill.pluginName } : {}),
        ...(typeof skill.marketplaceName === "string" ? { marketplace: skill.marketplaceName } : {}),
        ...(typeof skill.pluginId === "string" ? { pluginId: skill.pluginId } : {}),
        ...(typeof skill.marketplaceId === "string" ? { marketplaceId: skill.marketplaceId } : {}),
      });
    }
    const skillsText = renderManuallyAttachedSkillsSection(attachedSkills.map(skill => ({
      fullPath: skill.path,
      content: skill.text,
    })));
    if (skillsText) userContent.push({ type: "text", text: skillsText });
  }
  const nonMediaContent: TextPart[] = [];
  appendNonMediaSelectedContextContent({
    userContent: nonMediaContent,
    selectedContext: selectedContext.nonMedia,
    simulatedMessagePrompts: [...selectedContext.simulatedMessagePrompts],
    recentAgents: [...selectedContext.recentAgents],
    selectedUIElements: [...selectedContext.uiElements],
    selectedBrowsers: [...selectedContext.browserTabs],
    selectedSubagents: [...selectedContext.selectedSubagents],
    consoleLogs: [...selectedContext.consoleLogs],
    pullRequestPrompts,
    prReviewSelections: toPrReviewInputs(hydratedGitPrDiffSelections),
    extraContextsToInclude,
    isLegacyAgentMatterhorn: config.modelInfo?.isLegacyAgentMatterhorn === true,
    isRawTrainingSlug: config.modelInfo?.isRawTrainingSlug === true,
  });
  userContent.push(...nonMediaContent);
  postEnrichmentAssemblyDuration.histogram(ctx, performance.now() - postEnrichmentStart);
  processSelectedContextDuration.histogram(ctx, performance.now() - processStart);
  return { userContent, selectedImages, selectedVideos, selectedDocuments, imageFilePaths, videoFilePaths, documentFilePaths };
}

function createAttachedMediaConfig(config: ContextProcessingConfig): {
  readonly featureFlags?: {
    readonly videoAttachmentInlineMaxBytes?: number;
    readonly videoAttachmentSignedUrlMaxBytes?: number;
  };
} {
  const inline = config.featureFlags?.videoAttachmentInlineMaxBytes;
  const signed = config.featureFlags?.videoAttachmentSignedUrlMaxBytes;
  if (inline === undefined && signed === undefined) {
    return {};
  }
  return {
    featureFlags: {
      ...(inline === undefined ? {} : { videoAttachmentInlineMaxBytes: inline }),
      ...(signed === undefined ? {} : { videoAttachmentSignedUrlMaxBytes: signed }),
    },
  };
}
