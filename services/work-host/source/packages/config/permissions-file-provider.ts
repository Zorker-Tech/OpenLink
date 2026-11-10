import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { getConfigDir } from "./paths.ts"
import { decodePermissionsFile } from "./permissions-file-decoder.ts"
import type {
  EffectivePermissions,
  Permissions,
  PermissionsAutoRunInstructions,
  PermissionsTransformer,
} from "./permissions-file-contracts.ts"

export type {
  EffectivePermissions,
  Permissions,
  PermissionsAutoRunInstructions,
  PermissionsTransformer,
} from "./permissions-file-contracts.ts"

export class PermissionsFileProvider {
  constructor(
    private readonly permissions: Permissions,
    private readonly instructions: PermissionsAutoRunInstructions,
  ) {}

  static getPermissionsFilePath(): string {
    return join(getConfigDir(), "permissions.json")
  }

  static async load(filePath?: string): Promise<PermissionsFileProvider | undefined> {
    const targetPath = filePath ?? PermissionsFileProvider.getPermissionsFilePath()
    if (!existsSync(targetPath)) return undefined

    try {
      const content = await readFile(targetPath, "utf8")
      const decoded = decodePermissionsFile(content)
      return decoded === undefined
        ? undefined
        : new PermissionsFileProvider(decoded.permissions, decoded.autoRunInstructions)
    } catch {
      return undefined
    }
  }

  async getPermissions(): Promise<EffectivePermissions> {
    return {
      allow: this.permissions.allow,
      deny: this.permissions.deny,
      approvalMode: "unrestricted",
      userConfiguredPolicy: { type: "insecure_none" },
    }
  }

  getAutoRunInstructions(): PermissionsAutoRunInstructions {
    return {
      allowInstructions: [...this.instructions.allowInstructions],
      blockInstructions: [...this.instructions.blockInstructions],
    }
  }

  async updatePermissions(transformer: PermissionsTransformer): Promise<void> {
    // The user's file is read-only to the host.
    void transformer
  }
}
