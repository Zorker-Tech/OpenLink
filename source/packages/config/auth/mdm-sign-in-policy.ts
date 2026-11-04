import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir, userInfo } from "node:os";
import { promisify } from "node:util";
import { createMdmSignInPolicyReader } from "./mdm-sign-in-policy-cache.ts";
import { readMdmPolicyValues } from "./mdm-sign-in-policy-sources.ts";

const execFileAsync = promisify(execFile);

const systemPolicyReader = createMdmSignInPolicyReader(() => readMdmPolicyValues({
  platform: process.platform,
  environment: process.env,
  homeDirectory: homedir(),
  username: process.platform === "darwin" ? userInfo().username : "",
  io: {
    async fileExists(path) {
      try {
        await fs.access(path);
        return true;
      } catch {
        return false;
      }
    },
    readFile: (path) => fs.readFile(path, "utf8"),
    async run(command, args) {
      const result = await execFileAsync(command, [...args]);
      return { stdout: result.stdout };
    },
  },
}));

export {
  MACOS_POLICY_DOMAINS,
  MDM_SIGN_IN_POLICY_HEADER_NAME,
  POLICY_CACHE_TTL_MS,
  SIGN_IN_POLICY_VIOLATION_ERROR,
  SIGN_IN_POLICY_VIOLATION_MESSAGE,
  SignInPolicyViolationError,
  SLATE_MDM_SIGN_IN_POLICY_ENV,
  WINDOWS_POLICY_REGISTRY_KEYS,
} from "./mdm-sign-in-policy-contracts.ts";
export { buildMdmSignInPolicyHeaderValue } from "./mdm-sign-in-policy-values.ts";

export const readMdmSignInPolicyHeaderValue = systemPolicyReader.readMdmSignInPolicyHeaderValue;
export const mdmSignInPolicyHeaders = systemPolicyReader.mdmSignInPolicyHeaders;
