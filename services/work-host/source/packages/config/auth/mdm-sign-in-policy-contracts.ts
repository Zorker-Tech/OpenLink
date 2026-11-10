export const MDM_SIGN_IN_POLICY_HEADER_NAME = "x-slate-mdm-signin-policy";
export const SIGN_IN_POLICY_VIOLATION_ERROR = "sign_in_policy_violation";
export const SIGN_IN_POLICY_VIOLATION_MESSAGE = "Sign-in on this device is restricted by your organization's device policy. Sign in with an allowed account to continue.";
export const MACOS_POLICY_DOMAINS = ["co.slate.dev", "co.slate.desktop"] as const;
export const WINDOWS_POLICY_REGISTRY_KEYS = [
  "HKLM\\SOFTWARE\\Policies\\Slate\\Slate",
  "HKLM\\SOFTWARE\\Policies\\Slate\\Desktop",
  "HKLM\\SOFTWARE\\Policies\\Slate\\Slate Dev",
] as const;
export const SLATE_MDM_SIGN_IN_POLICY_ENV = "SLATE_MDM_SIGN_IN_POLICY_JSON";
export const POLICY_CACHE_TTL_MS = 30_000;

export type RawPolicy = Record<string, unknown>;

export class SignInPolicyViolationError extends Error {
  constructor() {
    super(SIGN_IN_POLICY_VIOLATION_MESSAGE);
    this.name = "SignInPolicyViolationError";
  }
}

export interface MdmPolicySourceIo {
  fileExists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  run(command: string, args: readonly string[]): Promise<{ stdout: string }>;
}

export interface MdmPolicySourceContext {
  readonly platform: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly username: string;
  readonly io: MdmPolicySourceIo;
}
