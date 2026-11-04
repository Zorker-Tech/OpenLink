/** Project creation and membership changes made from the self-state tool. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serializeWorkflowFile } from "../../shared/workflow-model.ts";
import { isSafeFolderId } from "../storage/folder-id.ts";
import { getProjectDir, projectDirExists } from "./memory-service.ts";
import { isBlankAgentText, stateWriteFailed, stateWriteOk, type AgentStateDeps } from "./agent-state-contracts.ts";

export function createAgentProjectOperations(deps: AgentStateDeps) {
  return {
    async createProject(args: { slug: string; name: string; description?: string }) {
      const slug = args.slug.trim();
      if (!isSafeFolderId(slug)) return stateWriteFailed(`"${slug}" is not a valid project slug — use a short kebab-case id.`);
      if (isBlankAgentText(args.name)) return stateWriteFailed("a project needs a non-empty name.");

      const path = getProjectDir(deps.slateRoot, slug);
      const existed = projectDirExists(deps.slateRoot, slug);
      if (!existed) {
        await mkdir(path, { recursive: true });
        const definition = serializeWorkflowFile({
          name: args.name.trim(),
          description: args.description?.trim() ?? "",
          body: "",
          trigger: null,
        });
        await writeFile(join(path, "project.md"), definition, "utf8");
      }

      if (!deps.membership.join(slug)) return stateWriteFailed(`could not join project "${slug}" — the slug is not path-safe.`);
      return stateWriteOk(existed
        ? `Joined existing project "${slug}" (create-is-join; project.md left as-is).`
        : `Created and joined project "${args.name.trim()}" (folder ${slug}).`);
    },

    async joinProject(args: { slug: string }) {
      const slug = args.slug.trim();
      if (!isSafeFolderId(slug)) return stateWriteFailed(`"${slug}" is not a valid project slug — use a short kebab-case id.`);
      if (!projectDirExists(deps.slateRoot, slug)) return stateWriteFailed(`no project "${slug}" exists. Create it first (action "create").`);
      return deps.membership.join(slug) ? stateWriteOk(`Joined project "${slug}".`) : stateWriteFailed(`could not join project "${slug}".`);
    },

    async leaveProject(args: { slug: string }) {
      const slug = args.slug.trim();
      if (!isSafeFolderId(slug)) return stateWriteFailed(`"${slug}" is not a valid project slug — use a short kebab-case id.`);
      return deps.membership.leave(slug) ? stateWriteOk(`Left project "${slug}".`) : stateWriteFailed(`could not leave project "${slug}".`);
    },
  };
}
