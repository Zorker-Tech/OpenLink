export interface SavedEnvironment {
  readonly publicId: string;
  readonly name: string;
  readonly repoConfig?: {
    readonly repos: readonly {
      readonly repoUrl: string;
      readonly scmRepoNodeId?: string;
      readonly gitEnterpriseUuid?: string;
    }[];
  };
}

export type CloudAgentEnvironment =
  | { readonly type: "cloud" }
  | { readonly type: "environment"; readonly publicId?: string; readonly name?: string }
  | { readonly type: "pool"; readonly name?: string; readonly teamId?: number }
  | { readonly type: "machine"; readonly name: string; readonly teamId?: number };
