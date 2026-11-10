export type ScmProvider = "github" | "gitlab" | "bitbucket" | "azure_devops" | "generic";

export interface ParsedGitUrl {
  readonly provider: ScmProvider;
  readonly owner: string;
  readonly repo: string;
  readonly host: string;
}

export type ScmRepository =
  | { readonly url: string; readonly owner: string; readonly repo: string; readonly host: string; readonly provider: "github" | "gitlab" | "bitbucket"; readonly project?: undefined }
  | { readonly url: string; readonly owner: string; readonly repo: string; readonly host: string; readonly provider: "azure_devops"; readonly project: string };

export type ScmUrlResult = ScmRepository | { readonly error: string };
