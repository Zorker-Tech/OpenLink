import type { SlateManagedSkillsService } from "./managed-skills-service.ts"

export interface RenewalEvent {
  readonly outcome: string
  readonly isFirstCredential?: boolean
}

export interface ManagedAuthPort {
  getAccessToken(args?: unknown): Promise<string>
  getMachineId(): string
  peekAccessToken(): string | null
  subscribeToRenewal?(listener: (event: RenewalEvent) => void): () => void
  onDidChange?(listener: () => void): () => void
  getLastRenewalEvent?(): RenewalEvent | null
}

export interface ManagedSetupContext {
  readonly deps: {
    readonly auth: ManagedAuthPort
    readonly telemetry?: {
      readonly logs: { reportHostExtensionDiagnostic(event: unknown): void }
    }
  }
  readonly createManagedSkills: (args: {
    readonly getAccessToken: () => Promise<string | null>
    readonly report: (event: unknown) => void
  }) => SlateManagedSkillsService
  readonly createTeamRules: (args: {
    readonly auth: ManagedAuthPort
    readonly report: (event: unknown) => void
  }) => {
    start(): void
    refresh(): void
    resolveRules(): Promise<readonly unknown[] | undefined>
  }
  readonly fetchSkillCatalog: (getAccessToken: () => Promise<string | null>) => Promise<unknown[]>
  readonly onStop: (dispose: () => void) => void
}
