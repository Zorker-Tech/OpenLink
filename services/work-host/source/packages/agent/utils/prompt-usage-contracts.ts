export interface PromptTokenBreakdownCategoryValue {
  readonly id: string;
  readonly label: string;
  readonly estimatedTokens: number;
  readonly characterCount?: number;
}

export interface PromptTokenBreakdownSnapshotValue {
  readonly totalUsedTokens: number;
  readonly maxTokens: number;
  readonly categories: readonly PromptTokenBreakdownCategoryValue[];
}

export interface PromptContextSourceValue {
  readonly sourceType: string;
  readonly messageIndex: number;
  readonly contentPath: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface PromptContextNodeValue {
  readonly id: string;
  readonly parentId?: string | undefined;
  readonly kind: string;
  readonly label: string;
  readonly categoryId: string;
  readonly estimatedTokens: number;
  readonly characterCount: number;
  readonly contentAvailable: boolean;
  readonly source?: PromptContextSourceValue | undefined;
  readonly inlineContent?: string | undefined;
}

export interface PromptContextUsageTreeValue {
  readonly schemaVersion: number;
  readonly nodes: readonly PromptContextNodeValue[];
}
