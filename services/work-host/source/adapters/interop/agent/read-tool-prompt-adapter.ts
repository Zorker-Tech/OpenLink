/** Translate model prompt variants into the Slate read-tool profile the core builder consumes. */

export type ReadArgumentStyle = "workspace-target" | "path-range" | "path-offset" | "path-only"
export type ReadDescriptionStyle = "standard" | "image" | "full" | "compact-image" | "image-only"

export interface ReadPromptProfile {
  readonly toolName: string
  readonly argumentStyle: ReadArgumentStyle
  readonly allowNegativeOffset: boolean
  readonly descriptionStyle: ReadDescriptionStyle
}

export interface ReadPromptProfileOptions {
  readonly imageOnly?: boolean
  readonly allowNegativeOffset?: boolean
}

export function resolveReadPromptProfile(version: string, options: ReadPromptProfileOptions = {}): ReadPromptProfile {
  if (options.imageOnly === true) {
    return { toolName: "ViewImage", argumentStyle: "path-only", allowNegativeOffset: false, descriptionStyle: "image-only" }
  }

  switch (version) {
    case "dsv3-1018":
      return { toolName: "read_file", argumentStyle: "workspace-target", allowNegativeOffset: false, descriptionStyle: "standard" }
    case "haiku":
      return { toolName: "Read", argumentStyle: "path-range", allowNegativeOffset: false, descriptionStyle: "full" }
    case "gpt5-codex":
    case "codex-cloud":
      return { toolName: "ReadFile", argumentStyle: "path-offset", allowNegativeOffset: options.allowNegativeOffset === true, descriptionStyle: "full" }
    case "cursor-0226":
      return { toolName: "Read", argumentStyle: "path-offset", allowNegativeOffset: true, descriptionStyle: "compact-image" }
    case "dsv3-1205":
      return { toolName: "Read", argumentStyle: "path-offset", allowNegativeOffset: options.allowNegativeOffset === true, descriptionStyle: "image" }
    case "latest":
      return { toolName: "Read", argumentStyle: "path-offset", allowNegativeOffset: options.allowNegativeOffset === true, descriptionStyle: "full" }
    default:
      throw new Error(`Unhandled version: ${version}`)
  }
}
