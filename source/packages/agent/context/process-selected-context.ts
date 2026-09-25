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

import path from "node:path"

import type { Context } from "../../context/context.ts"
import { createLogger } from "../../context/index.ts"
import { createHistogram } from "../../metrics/index.ts"
import { getBlobId, type BlobStore } from "../../agent-kv/blob-store.ts"
import { asyncMapValues } from "../../utils/promise-tools.ts"
import { writeExecutorResource } from "../../agent-exec/write-operation.ts"
import { WriteArgs } from "../../proto/generated/agent/v1/write_exec_pb.ts"
import { AgentMode, type SimulatedMsgReason as SimulatedMsgReasonValue } from "../../proto/generated/agent/v1/agent_pb.ts"
import {
  InvocationContext,
  SelectedDocument,
  SelectedGitPRDiffSelection,
  SelectedPullRequest,
  SelectedVideo,
  type SelectedContext,
  type SelectedDocument as SelectedDocumentValue,
  type SelectedImage as SelectedImageValue,
  type SelectedVideo as SelectedVideoValue,
} from "../../proto/generated/agent/v1/selected_context_pb.ts"
import { BackgroundComposerSource } from "../../proto/generated/aiserver/v1/background_composer_pb.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import { AgentType } from "../utils/agent-config.ts"
import { getFilenameWithoutExtension, getSkillSourceFromPath } from "../utils/common-helpers.ts"
import { sanitizeFilename } from "../../utils/managed-paths.ts"
import { getSkillIdFromPath } from "../skill-id.ts"
import { recordSkillApplied } from "../utils/event-tracking.ts"
import { getInlineVideoMaxBytes, getSignedUrlVideoMaxBytes, isSignedUrlStorageAllowed } from "../attached-media.ts"
import { detectImageMimeType } from "../tools/core/read/image-utils.ts"
import { renderAgentNotesContext } from "./agent-notes-context.ts"
import { renderSelectedCodeSelections } from "./code-selection-context.ts"
import { renderConsoleLogsContext } from "./console-logs-context.ts"
import { renderSelectedCursorCommands } from "./cursor-commands-context.ts"
import { processDocumentAttachment } from "./document-attachment.ts"
import { hydrateSelectedDocumentation, type DocumentationHydrationService } from "./documentation-hydration.ts"
import { renderDocumentationContext, type DocumentationResult } from "./documentation-context.ts"
import { hydrateSelectedExtraContext } from "./extra-context-hydration.ts"
import { renderExternalLinksContext } from "./external-links-context.ts"
import { renderAttachedFoldersContext } from "./attached-folders-context.ts"
import { hydrateSelectedImageData } from "./image-data-hydration.ts"
import { writeSelectedImageToProjectAssets } from "./image-file-spill.ts"
import { hydrateSelectedInvocationContext } from "./invocation-hydration.ts"
import { renderGithubPrInvocationContext } from "./github-pr-context.ts"
import { renderInvocationPlatformContext } from "./invocation-platforms.ts"
import { renderManuallyAttachedSkillsSection } from "../manually-attached-skills.ts"
import { appendNonMediaSelectedContextContent } from "./non-media-assembly.ts"
import { hydrateGitPrDiffSelections, hydrateSelectedPullRequests } from "./pr-hydration.ts"
import { renderPrReviewContext } from "./pr-review-context.ts"
import { renderRecentAgentsContext } from "./recent-agents-context.ts"
import { resolveSelectedContextSkillSections } from "../selected-context-skills.ts"
import { renderSelectedBrowsersContext } from "./selected-browsers-context.ts"
import { renderSelectedSubagentDelegation } from "./selected-subagents-context.ts"
import { renderSimulatedMessagePrompts } from "../simulated-message-prompts.ts"
import { renderSelectedTerminalContext } from "./terminal-context.ts"
import { renderSelectedUIElementsContext } from "./ui-elements-context.ts"
import { renderUploadedDocumentsContext } from "./uploaded-documents.ts"
import { processVideoAttachment } from "./video-attachment.ts"
import { processSelectedVideoPathOnly } from "./video-path-processing.ts"
import { canUseWatchVideoSubagent } from "./watch-video-eligibility.ts"
import type { AttachmentPathRequestContext } from "./path-trust.ts"
import type { AttachedMediaUrlProvider } from "./video-attachment.ts"
import type { CodeSelectionFormattingOptions } from "./code-selection-context.ts"
import type { TaskToolModelInfo } from "../tools/task-tool-name.ts"

interface TextPart { readonly type: "text"; readonly text: string }
interface ImagePart {
  readonly type: "image";
  readonly image: Uint8Array | string | URL;
  readonly mimeType: string;
  readonly providerOptions?: { readonly cursor: { readonly mimeType?: string; readonly videoFps?: number } };
}
type UserContentPart = TextPart | ImagePart;

interface ResourceAccessor {
  get(resource: typeof writeExecutorResource): { execute(ctx: Context, args: WriteArgs): Promise<unknown> };
}

interface ProcessRequestContext extends AttachmentPathRequestContext {
  readonly conversationNotesListing?: string;
  readonly sharedNotesListing?: string;
}

interface WebPageData {
  readonly pageUrl: string;
  readonly pageTitle: string;
  readonly partialParsedPageContents: string;
  readonly imageData?: Uint8Array;
  readonly imageMimeType?: string;
}

interface ContextProcessingConfig {
  readonly enableTerminalFiles: boolean;
  readonly enableAgentNotes: boolean;
  readonly enableImageFiles: boolean;
  readonly enableLongCodeSelectionSpillToFile: boolean;
  readonly formattingOptions: CodeSelectionFormattingOptions;
  readonly agentType?: AgentType;
  readonly backgroundAgentSource?: BackgroundComposerSource;
  readonly modelInfo?: TaskToolModelInfo & {
    readonly isComposerMatterhorn?: boolean;
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
    readonly enableSlackVideoAttachments?: boolean;
    readonly enableWatchVideoInIdeSubagent?: boolean;
    readonly geminiVideoAttachmentInlineMaxBytes?: number;
    readonly geminiVideoAttachmentSignedUrlMaxBytes?: number;
  };
  readonly webScraperService: {
    getContentInWebsiteFast(ctx: Context, url: string): Promise<WebPageData | null>;
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
  description: "Time to hydrate and process invocation context (Slack thread, GitHub PR, IDE state)", labelNames: ["kind"],
});
const processSelectedContextDuration = createHistogram("agent.ttft.processSelectedContextMs", {
  description: "Total wall-clock time for the entire processSelectedContext function",
});
const postEnrichmentAssemblyDuration = createHistogram("agent.ttft.postEnrichmentAssemblyMs", {
  description: "Time for sync context assembly after enrichment (rules, skills, git diffs, PRs, etc.)",
});
const MAX_RULE_LENGTH = 100_000;
const EXTERNAL_LINK_ENRICHMENT_MAX_CONCURRENCY = 4;
const EXTERNAL_LINK_INLINE_LIMIT = 20_000;
const EXTERNAL_LINK_CONTENT_TRUNCATION_LIMIT = 500_000;

export async function processSelectedContext(
  ctx: Context,
  selectedContext: SelectedContext,
  blobStore: BlobStore<Context> | undefined,
  config: ContextProcessingConfig,
  requestContext: ProcessRequestContext | undefined,
  resourceAccessor: ResourceAccessor | undefined,
  mode: AgentMode,
  _modelId: string | undefined,
  conversationQuery: string,
  simulatedMsgReason: SimulatedMsgReasonValue,
  privacyMode: PrivacyMode,
): Promise<{
  userContent: UserContentPart[];
  selectedImages: SelectedImageValue[];
  selectedVideos: SelectedVideoValue[];
  selectedDocuments: SelectedDocumentValue[];
  imageFilePaths: string[];
  videoFilePaths: string[];
  documentFilePaths: string[];
}> {
  const userContent: UserContentPart[] = [];
  const selectedImages: SelectedImageValue[] = [];
  const selectedVideos: SelectedVideoValue[] = [];
  const selectedDocuments: SelectedDocumentValue[] = [];
  const imageFilePaths: string[] = [];
  const videoFilePaths: string[] = [];
  const documentFilePaths: string[] = [];
  const processStart = performance.now();

  const invocationStart = performance.now();
  const resolvedInvocationContext = await hydrateSelectedInvocationContext({
    ctx,
    invocationContext: selectedContext.invocationContext,
    blobStore,
  });
  if (resolvedInvocationContext) {
    const invocationContent = resolvedInvocationContext.data.case === "githubPr"
      ? { type: "text" as const, text: renderGithubPrInvocationContext(resolvedInvocationContext.data.value) }
      : renderInvocationPlatformContext(resolvedInvocationContext, config.enableTerminalFiles);
    if (invocationContent) userContent.push(invocationContent);
  }
  invocationContextDuration.histogram(ctx, performance.now() - invocationStart, {
    kind: resolvedInvocationContext?.data.case ?? "none",
  });
  const agentNotes = renderAgentNotesContext({
    mode,
    enableAgentNotes: config.enableAgentNotes,
    metaAgentNotes: config.featureFlags?.metaAgentNotes === true,
    conversationNotesListing: requestContext?.conversationNotesListing,
    sharedNotesListing: requestContext?.sharedNotesListing,
  });
  if (agentNotes) userContent.push(agentNotes);

  const hasImages = selectedContext.selectedImages.length > 0;
  const hasVideos = selectedContext.selectedVideos.length > 0;
  const hasDocs = selectedContext.selectedDocuments.length > 0;
  const blobHydrationStart = performance.now();
  const imageProcessingPromise = Promise.all(selectedContext.selectedImages.map(async (selectedImage, index) => {
    const hydrated = await hydrateSelectedImageData({ ctx, blobStore: blobStore!, selectedImage });
    const mimeType = selectedImage.mimeType.trim() || (hydrated.imageData ? detectImageMimeType(hydrated.imageData, selectedImage.path) : undefined) || "image/png";
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
    return { selectedImage: hydrated.selectedImage, imageData: hydrated.imageData, mimeType, imageFilePath };
  }));
  const videoProcessingPromise = Promise.all(selectedContext.selectedVideos.map(async (selectedVideo, index) => {
    const pathOnly = await processSelectedVideoPathOnly({ ctx, selectedVideo, requestContext });
    if (pathOnly !== undefined) return pathOnly;
    const useSignedUrl = !selectedVideo.materializeToFilesystem &&
      isSignedUrlStorageAllowed(privacyMode) && config.attachedMediaUrlProvider !== undefined;
    return processVideoAttachment({
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
  const documentProcessingPromise = Promise.all(selectedContext.selectedDocuments.map((selectedDocument, index) => processDocumentAttachment({
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
    if (result.selectedImage) selectedImages.push(result.selectedImage);
    if (result.imageFilePath) imageFilePaths.push(result.imageFilePath);
    if (result.imageData) userContent.push({ type: "image", image: new Uint8Array(result.imageData), mimeType: result.mimeType });
  }
  for (const result of videoResults) {
    if (result.processedSelectedVideo) selectedVideos.push(result.processedSelectedVideo);
    if (result.localFilePath) {
      videoFilePaths.push(result.localFilePath);
      allVideoInfos.push({ path: result.localFilePath });
    }
    if ("videoUrl" in result && result.videoUrl) {
      userContent.push({
        type: "image",
        image: new URL(result.videoUrl),
        mimeType: result.mimeType,
        providerOptions: { cursor: { mimeType: result.mimeType, ...(result.fps === undefined ? {} : { videoFps: result.fps }) } },
      });
    } else if (result.videoData) {
      userContent.push({
        type: "image",
        image: `data:${result.mimeType};base64,${Buffer.from(result.videoData).toString("base64")}`,
        mimeType: result.mimeType,
        ...(result.fps === undefined ? {} : { providerOptions: { cursor: { videoFps: result.fps } } }),
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
    codeSelections: selectedContext.codeSelections,
    formattingOptions: config.formattingOptions,
    enableLongCodeSelectionSpillToFile: config.enableLongCodeSelectionSpillToFile,
    requestContext,
    resourceAccessor,
  });
  allDocumentInfos.push(...renderedCodeSelections.documentInfos);
  const attachedFilesContent = [...renderedCodeSelections.attachedFilesContent];
  attachedFilesContent.push(...renderSelectedTerminalContext(selectedContext.terminals, selectedContext.terminalSelections, config.formattingOptions));
  const attachedFoldersText = renderAttachedFoldersContext(selectedContext.folders);
  if (attachedFoldersText) attachedFilesContent.push({ type: "text", text: attachedFoldersText });
  if (attachedFilesContent.length > 0) {
    userContent.push({ type: "text", text: `<attached_files>\n${attachedFilesContent.map(part => part.text).join("\n")}\n</attached_files>` });
  }

  const externalLinksTask = async () => {
    if (selectedContext.externalLinks.length === 0) return { links: [], documents: [], images: [] };
    const indexedLinks = selectedContext.externalLinks.map((link, index) => ({ link, index }));
    const results = await asyncMapValues(indexedLinks, async ({ link, index }) => {
      const page = await config.webScraperService.getContentInWebsiteFast(ctx, link.url);
      if (page === null) return { linkContent: undefined, documentInfo: undefined, imageData: undefined };
      if (page.imageData && page.imageData.length > 0 && page.imageMimeType) {
        return { linkContent: undefined, documentInfo: undefined, imageData: { imageBytes: page.imageData, mimeType: page.imageMimeType } };
      }
      if (page.partialParsedPageContents.length <= EXTERNAL_LINK_INLINE_LIMIT) {
        return { linkContent: { url: page.pageUrl, title: page.pageTitle, content: page.partialParsedPageContents }, documentInfo: undefined, imageData: undefined };
      }
      const basename = (() => {
        try {
          const parsed = new URL(page.pageUrl);
          return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? parsed.hostname);
        } catch { return "link"; }
      })();
      const withExtension = /\.(md|txt|html|htm|json|xml|csv|tsv|yaml|yml|rst|tex|log)$/i.test(basename) ? basename : `${basename}.md`;
      const safe = sanitizeFilename(withExtension) || "link.md";
      const dot = safe.lastIndexOf(".");
      const fileName = `${safe.slice(0, dot)}-${index}${safe.slice(dot)}`;
      const rootPath = requestContext?.env?.projectFolder ?? requestContext?.env?.workspacePaths?.[0];
      if (resourceAccessor && rootPath !== undefined) {
        try {
          const filePath = path.join(rootPath, "uploads", fileName);
          const content = page.partialParsedPageContents.length > 500_000
            ? page.partialParsedPageContents.slice(0, 500_000) + `\n\n[${(page.partialParsedPageContents.length - 500_000).toLocaleString()} characters truncated due to size]`
            : page.partialParsedPageContents;
          await resourceAccessor.get(writeExecutorResource).execute(ctx, new WriteArgs({
            path: filePath,
            fileBytes: new TextEncoder().encode(`Source URL: ${page.pageUrl}\nTitle: ${page.pageTitle}\n\n${content}`),
            returnFileContentAfterWrite: false,
          }));
          return { linkContent: undefined, documentInfo: { path: filePath }, imageData: undefined };
        } catch (error) {
          logger.warn(ctx, "Failed to write external link content to file", { url: page.pageUrl, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const content = page.partialParsedPageContents.length > EXTERNAL_LINK_INLINE_LIMIT
        ? page.partialParsedPageContents.slice(0, EXTERNAL_LINK_INLINE_LIMIT) + `\n\n[${(page.partialParsedPageContents.length - EXTERNAL_LINK_INLINE_LIMIT).toLocaleString()} characters truncated due to size]`
        : page.partialParsedPageContents;
      return { linkContent: { url: page.pageUrl, title: page.pageTitle, content }, documentInfo: undefined, imageData: undefined };
    }, { max: EXTERNAL_LINK_ENRICHMENT_MAX_CONCURRENCY });
    const links: Array<{ url: string; title: string; content: string }> = [];
    const documents: Array<{ path: string }> = [];
    const images: Array<{ imageBytes: Uint8Array; mimeType: string }> = [];
    for (const result of results) {
      if (result.linkContent) links.push(result.linkContent);
      if (result.documentInfo) documents.push(result.documentInfo);
      if (result.imageData) images.push(result.imageData);
    }
    return { links, documents, images };
  };
  const hasExternalLinks = selectedContext.externalLinks.length > 0;
  const hasDocumentation = selectedContext.documentations.length > 0;
  const hasBlobStoreWork = selectedContext.selectedPullRequests.length > 0 || selectedContext.gitPrDiffSelections.length > 0 || selectedContext.extraContextEntries.length > 0 || selectedContext.extraContext.length > 0;
  const enrichStart = performance.now();
  const externalStart = performance.now();
  const externalResult = await externalLinksTask();
  enrichContextExternalLinksDuration.histogram(ctx, performance.now() - externalStart, { hasWork: hasExternalLinks ? "true" : "false" });
  const documentationStart = performance.now();
  const documentationResult = await hydrateSelectedDocumentation({ ctx, documentations: selectedContext.documentations, documentationHydrationService: config.documentationHydrationService, conversationQuery });
  enrichContextDocumentationDuration.histogram(ctx, performance.now() - documentationStart, { hasWork: hasDocumentation ? "true" : "false" });
  const blobStart = performance.now();
  const hydratedSelectedPullRequests = await hydrateSelectedPullRequests({ ctx, selectedPullRequests: selectedContext.selectedPullRequests, blobStore });
  const hydratedGitPrDiffSelections = await hydrateGitPrDiffSelections({ ctx, gitPrDiffSelections: selectedContext.gitPrDiffSelections, blobStore });
  const extraContextsToInclude = await hydrateSelectedExtraContext(ctx, selectedContext, blobStore);
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
    const watch = canUseWatchVideoSubagent({ agentType: config.agentType, backgroundAgentSource: config.backgroundAgentSource, featureFlags: config.featureFlags })
      ? " You can watch them using your WatchVideo subagent." : "";
    userContent.push({ type: "text", text: `<attached_videos>\nThe following videos have been attached by the user and saved to your filesystem.${watch}\n${videosList}\n</attached_videos>` });
  }
  const documentationText = renderDocumentationContext(documentationResult);
  if (documentationText) userContent.push({ type: "text", text: documentationText });
  const { selectedSkills, regularRules } = resolveSelectedContextSkillSections(selectedContext);
  const dropCustomPromptContext = config.featureFlags?.dropCustomPromptContext === true;
  if (!dropCustomPromptContext && regularRules.length > 0) {
    const rulesText = regularRules.map(rule => `Rule Name: ${rule.fullPath ? getFilenameWithoutExtension(rule.fullPath) : "Cursor Rule"}\nDescription: ${rule.content?.slice(0, MAX_RULE_LENGTH) ?? ""}`).join("\n\n");
    userContent.push({ type: "text", text: `<cursor_rules_context>\nCursor Rules are extra documentation provided by the user to help the AI understand the codebase.\nUse them if they seem useful to the users most recent query, but do not use them if they seem unrelated to the current query.\n\n${rulesText}\n</cursor_rules_context>\n` });
  }
  if (!dropCustomPromptContext && selectedSkills.length > 0) {
    const attachedSkills = selectedSkills.filter((skill): skill is typeof skill & { fullPath: string; content: string } =>
      typeof skill.fullPath === "string" && typeof skill.content === "string");
    const seen = new Set<string>();
    for (const skill of attachedSkills) {
      const fullPath = skill.fullPath.trim();
      if (!fullPath || seen.has(fullPath)) continue;
      seen.add(fullPath);
      recordSkillApplied(ctx, {
        entrypoint: "manually_attached",
        skillId: getSkillIdFromPath(fullPath),
        skillSource: getSkillSourceFromPath(fullPath),
        ...(typeof skill.plugin === "string" ? { plugin: skill.plugin } : {}),
        ...(typeof skill.marketplace === "string" ? { marketplace: skill.marketplace } : {}),
        ...(typeof skill.pluginId === "string" ? { pluginId: skill.pluginId } : {}),
        ...(typeof skill.marketplaceId === "string" ? { marketplaceId: skill.marketplaceId } : {}),
      });
    }
    const skillsText = renderManuallyAttachedSkillsSection(attachedSkills);
    if (skillsText) userContent.push({ type: "text", text: skillsText });
  }
  const nonMediaContent: TextPart[] = [];
  appendNonMediaSelectedContextContent({
    userContent: nonMediaContent,
    selectedContext,
    hydratedSelectedPullRequests,
    hydratedGitPrDiffSelections,
    extraContextsToInclude,
    isComposerMatterhorn: config.modelInfo?.isComposerMatterhorn === true,
    isRawTrainingSlug: config.modelInfo?.isRawTrainingSlug === true,
    simulatedMsgReason,
    modelInfo: config.modelInfo,
    environmentParamForSubagent: config.featureFlags?.environmentParamForSubagent === true,
    babysitV2Prompt: config.featureFlags?.babysitV2Prompt === true,
    enablePrCreationForgeGuidance: config.featureFlags?.prCreationForgeGuidance === true,
  });
  userContent.push(...nonMediaContent);
  postEnrichmentAssemblyDuration.histogram(ctx, performance.now() - postEnrichmentStart);
  processSelectedContextDuration.histogram(ctx, performance.now() - processStart);
  return { userContent, selectedImages, selectedVideos, selectedDocuments, imageFilePaths, videoFilePaths, documentFilePaths };
}

function createAttachedMediaConfig(config: ContextProcessingConfig): {
  readonly featureFlags?: {
    readonly geminiVideoAttachmentInlineMaxBytes?: number;
    readonly geminiVideoAttachmentSignedUrlMaxBytes?: number;
  };
} {
  const inline = config.featureFlags?.geminiVideoAttachmentInlineMaxBytes;
  const signed = config.featureFlags?.geminiVideoAttachmentSignedUrlMaxBytes;
  if (inline === undefined && signed === undefined) {
    return {};
  }
  return {
    featureFlags: {
      ...(inline === undefined ? {} : { geminiVideoAttachmentInlineMaxBytes: inline }),
      ...(signed === undefined ? {} : { geminiVideoAttachmentSignedUrlMaxBytes: signed }),
    },
  };
}
