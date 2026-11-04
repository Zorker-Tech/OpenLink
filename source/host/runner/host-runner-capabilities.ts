import type { Context } from "../../packages/context/context.ts";
import type { TransferBox } from "../boxes/box-transfer.ts";
import type { CapableBox } from "../boxes/box-capabilities.ts";
import type { UserComputerHandle } from "./tools/slate-file-transfer-tools.ts";
import type { RemoteBoxResourceHost } from "./remote-box-resources.ts";

type Callable = (...args: any[]) => any;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function boundMethod(value: unknown, name: string): Callable | undefined {
  const member = recordOf(value)?.[name];
  return typeof member === "function" ? (...args) => Reflect.apply(member, value, args) : undefined;
}

function bindRequired(value: unknown, names: readonly string[]): Record<string, Callable> | undefined {
  const methods: Record<string, Callable> = {};
  for (const name of names) {
    const method = boundMethod(value, name);
    if (method === undefined) return undefined;
    methods[name] = method;
  }
  return methods;
}

function bindAvailable(value: unknown, names: readonly string[]): Record<string, Callable> {
  const methods: Record<string, Callable> = {};
  for (const name of names) {
    const method = boundMethod(value, name);
    if (method !== undefined) methods[name] = method;
  }
  return methods;
}

export function isAgentContext(value: unknown): value is Context {
  return bindRequired(value, ["with", "get", "withCancel"]) !== undefined;
}

export function asTransferBox(value: unknown): TransferBox | undefined {
  const methods = bindRequired(value, ["downloadFile", "uploadFile"]);
  if (methods === undefined) return undefined;
  return {
    downloadFile: methods.downloadFile as TransferBox["downloadFile"],
    uploadFile: methods.uploadFile as TransferBox["uploadFile"],
  };
}

/** Optional capabilities stay absent; a present method keeps the receiver it came from. */
export function asCapableTransferBox(value: unknown): TransferBox & CapableBox | undefined {
  const transfer = asTransferBox(value);
  if (transfer === undefined) return undefined;
  return Object.assign(transfer, bindAvailable(value, ["getTerminalsFolder", "isAvailable", "isPreparing", "getAgentWindowIndex"])) as TransferBox & CapableBox;
}

export function asRemoteBoxResourceOwner(value: unknown): RemoteBoxResourceHost["remoteBox"] | undefined {
  const box = asCapableTransferBox(value);
  const ensureReady = boundMethod(value, "ensureReady");
  if (box === undefined || ensureReady === undefined) return undefined;
  return { ...box, ensureReady: ensureReady as RemoteBoxResourceHost["remoteBox"]["ensureReady"] };
}

function asUserComputer(value: unknown): UserComputerHandle | undefined {
  const candidate = recordOf(value);
  if (candidate === undefined) return undefined;
  const box = asTransferBox(candidate.box);
  if (typeof candidate.id !== "string" || typeof candidate.label !== "string" || typeof candidate.connected !== "boolean" || box === undefined) return undefined;
  return { id: candidate.id, label: candidate.label, connected: candidate.connected, box };
}

interface PromptUserComputerDirectory {
  resolve(computerId?: string): UserComputerHandle | undefined;
  list(): readonly UserComputerHandle[];
}

export function asPromptUserComputers(value: unknown): PromptUserComputerDirectory | undefined {
  const candidate = recordOf(value);
  const resolveComputer = boundMethod(value, "resolve");
  const listComputers = boundMethod(value, "list");
  if (candidate === undefined || resolveComputer === undefined || listComputers === undefined) return undefined;
  return {
    resolve: (computerId) => asUserComputer(resolveComputer(computerId)),
    list: () => {
      const listing = listComputers();
      if (!Array.isArray(listing)) return [];
      return listing.flatMap((computer) => {
        const projected = asUserComputer(computer);
        return projected === undefined ? [] : [projected];
      });
    },
  };
}
