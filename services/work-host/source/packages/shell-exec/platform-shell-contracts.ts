export interface ShellPathResolutionPorts {
  readonly platform: NodeJS.Platform;
  readonly shell?: string;
  readonly systemRoot?: string;
  readonly findExecutable: (name: string, matcher?: RegExp) => string;
  readonly exists: (path: string) => boolean;
  readonly join: (...parts: string[]) => string;
}
