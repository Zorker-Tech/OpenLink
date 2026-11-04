export interface InlineHook {
  hookStep?: string;
  isActive?: boolean;
  operatingSystems?: string[];
  hookType?: string;
  promptContent?: string;
  promptModel?: string;
  scriptContent?: string;
}

export interface InlineContent {
  rules?: Array<{ name: string; content?: string; isActive?: boolean; globs?: string[]; isRequired?: boolean }>;
  commands?: Array<{ name: string; content?: string; isActive?: boolean; description?: string }>;
  hooks?: InlineHook[];
  mcpServers?: Array<{ name: string; config?: unknown }>;
}

export interface InlineManifestPaths {
  rules?: string[];
  commands?: string[];
}
