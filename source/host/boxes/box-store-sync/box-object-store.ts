/**
 * Where a box's store lives, as one object store at a time.
 *
 * Three backends answer the same small surface — get, put, get to a file, put from a file, prefetch, list — and which
 * one a box uses is the platform's own policy: a local directory when one is configured, the platform's own service
 * when the box is in its store, and the agent store otherwise. Two things hold for all of them: the store is
 * **append-only** (a delete is refused rather than half-done), and a key is a path in the store, never a path on this
 * machine.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { findSystemErrno } from "../../../shared/system-errno.ts";
import { invariant } from "../../../shared/invariant.ts";
import { getBoxStoreBackendPolicy } from "../box-store-backend-policy.ts";
import {
  AgentStoreMutableWriteEtags,
  createAgentStoreClient,
  fetchAgentStoreObjectFromUrl,
  fetchAgentStoreObjectToFileFromUrl,
  getAgentStoreObject,
  getAgentStoreObjectToFile,
  listAgentStoreObjects,
  presignAgentStoreReadBatch,
  putAgentStoreObject,
  putAgentStoreObjectContentAddressed,
  putAgentStoreObjectFromFile,
  type AgentStoreClient,
  type AgentStoreClientDependencies,
} from "./agent-store-slate-files.ts";
import { BoxStoreCanonicalWriteConflictError } from "./object-store-port.ts";
import { SlateBoxStoreServiceProvider, type SlateBoxStoreServiceDependencies } from "./slate-box-store-files.ts";
import { BoxStoreSyncError } from "./box-store-sync-error.ts";

export interface BoxObjectStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, content: Uint8Array, options?: { readonly contentAddressed?: boolean }): Promise<void>;
  getToFile?(key: string, destinationPath: string, options?: { readonly maxBytes?: number }): Promise<number | null>;
  putFromFile?(key: string, sourcePath: string, sha: string, size: number): Promise<void>;
  prefetchReads?(objectKeys: readonly string[]): Promise<void>;
  list(keyPrefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export interface BoxObjectStoreProvider {
  forStore(store: string): BoxObjectStore;
}

const PREFETCHED_READ_FRESHNESS_MARGIN_MS = 30_000;

/** Whether a failure is the file simply not being there. */
function isMissingFile(failure: unknown): boolean {
  return findSystemErrno(failure) === "ENOENT";
}

/** A stream copied to a path, with the directory it needs created first. */
async function copyStreamTo(destination: string, source: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await pipeline(createReadStream(source), createWriteStream(destination));
}

/** A dependency the store cannot work without: the callback the caller gave, or a refusal naming what is missing. */
function orRefusal(given: ((...args: unknown[]) => unknown) | undefined, missingMessage: string): (...args: unknown[]) => unknown {
  return given ?? (() => {
    invariant(false, missingMessage);
  });
}

/** The agent store as an object store: one client for every store id, and the etags it learns kept across them. */
export class AgentStoreObjectStoreProvider implements BoxObjectStoreProvider {
  private builtClient: AgentStoreClient | undefined;
  private readonly mutableEtags = new AgentStoreMutableWriteEtags();

  constructor(readonly deps: AgentStoreClientDependencies) {
    this.builtClient = deps.client;
  }

  forStore(store: string): AgentStoreObjectStore {
    return new AgentStoreObjectStore(this.client(), store, this.mutableEtags);
  }

  /** The client is built once, and only when a store is actually asked for. */
  private client(): AgentStoreClient {
    this.builtClient ??= createAgentStoreClient({
      getAccessToken: orRefusal(this.deps.getAccessToken, "AgentStoreObjectStore: no getAccessToken provided"),
      getMachineId: orRefusal(this.deps.getMachineId, "AgentStoreObjectStore: no getMachineId provided"),
    });
    return this.builtClient;
  }
}

export class AgentStoreObjectStore implements BoxObjectStore {
  private readonly prefetchedUrls = new Map<string, { readonly url: string; readonly expiresAtMs: number }>();

  constructor(
    readonly client: AgentStoreClient,
    readonly storeId: string,
    readonly mutableEtags: AgentStoreMutableWriteEtags,
  ) {}

  async prefetchReads(objectKeys: readonly string[]): Promise<void> {
    const presigned = await presignAgentStoreReadBatch(this.client, this.storeId, objectKeys);
    for (const [key, url] of presigned) this.prefetchedUrls.set(key, url);
  }

  /** A prefetched url is used once, and only while it has time left on it. */
  private consumePrefetched(key: string): { readonly url: string; readonly expiresAtMs: number } | undefined {
    const cached = this.prefetchedUrls.get(key);
    if (cached === undefined) return undefined;
    this.prefetchedUrls.delete(key);
    return cached.expiresAtMs - Date.now() > PREFETCHED_READ_FRESHNESS_MARGIN_MS ? cached : undefined;
  }

  /** Reads through a prefetched url when there is a fresh one, and falls back to the store otherwise. */
  private async prefetchedOrStore<T>(key: string, viaUrl: (url: string) => Promise<T | null>, viaStore: () => Promise<T | null>): Promise<T | null> {
    const cached = this.consumePrefetched(key);
    if (cached !== undefined) {
      try {
        const viaCache = await viaUrl(cached.url);
        if (viaCache !== null) return viaCache;
      } catch {
        // A prefetched url that failed is not the caller's problem: the object is read again below.
      }
    }
    return viaStore();
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.prefetchedOrStore(
      key,
      (url) => fetchAgentStoreObjectFromUrl(url, key),
      () => getAgentStoreObject(this.client, this.storeId, key),
    );
  }

  async put(key: string, content: Uint8Array, options?: { readonly contentAddressed?: boolean }): Promise<void> {
    if (options?.contentAddressed === true) {
      await putAgentStoreObjectContentAddressed({ client: this.client, sourceId: this.storeId, relPath: key, data: content });
      return;
    }
    const result = await putAgentStoreObject({ client: this.client, sourceId: this.storeId, relPath: key, data: content, etags: this.mutableEtags });
    // A lost race is the caller's to handle: the content was preserved under the conflict's own name.
    if (result.outcome === "conflict") {
      throw new BoxStoreCanonicalWriteConflictError({ key, conflictRelPath: result.conflictRelPath, baseEtag: result.baseEtag, baselineSource: result.baselineSource });
    }
  }

  async getToFile(key: string, destinationPath: string, options?: { readonly maxBytes?: number }): Promise<number | null> {
    return this.prefetchedOrStore(
      key,
      (url) => fetchAgentStoreObjectToFileFromUrl(url, key, destinationPath, options?.maxBytes),
      () => getAgentStoreObjectToFile(this.client, this.storeId, key, destinationPath, options?.maxBytes),
    );
  }

  putFromFile(key: string, sourcePath: string, sha: string, size: number): Promise<void> {
    return putAgentStoreObjectFromFile({ client: this.client, sourceId: this.storeId, relPath: key, srcPath: sourcePath, sha, size });
  }

  list(keyPrefix: string): Promise<string[]> {
    return listAgentStoreObjects(this.client, this.storeId, keyPrefix);
  }

  async delete(key: string): Promise<void> {
    invariant(false, () => `AgentStoreObjectStore is append-only; cannot delete ${key}`);
  }
}

/** The store as a plain directory, which is what a box with a local store uses. */
export class LocalFsObjectStoreProvider implements BoxObjectStoreProvider {
  constructor(readonly baseDir: string) {}

  forStore(store: string): LocalFsObjectStore {
    return new LocalFsObjectStore(join(this.baseDir, store));
  }
}

export class LocalFsObjectStore implements BoxObjectStore {
  constructor(readonly root: string) {}

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async put(objectKey: string, content: Uint8Array): Promise<void> {
    const dest = this.pathFor(objectKey);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }

  /** The size of a file, or nothing when it is not there. */
  private async statSizeOrNull(path: string): Promise<number | null> {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async getToFile(key: string, destinationPath: string, options?: { readonly maxBytes?: number }): Promise<number | null> {
    const src = this.pathFor(key);
    const size = await this.statSizeOrNull(src);
    if (size === null) return null;
    // The size is known before anything is copied, so a file over the cap is refused without being read.
    if (options?.maxBytes !== undefined && size > options.maxBytes) throw new BoxStoreSyncError(`object ${key} is ${size}B over the ${options.maxBytes}B cap`);
    await copyStreamTo(destinationPath, src);
    return size;
  }

  async putFromFile(key: string, sourcePath: string, _sha: string, _size: number): Promise<void> {
    const dest = this.pathFor(key);
    await copyStreamTo(dest, sourcePath);
  }

  async list(keyPrefix: string): Promise<string[]> {
    const found: string[] = [];
    await walkFiles(this.root, found);
    return found
      .map((absolutePath) => relative(this.root, absolutePath).split(sep).join("/"))
      .filter((key) => isUnderPrefix(key, keyPrefix))
      .sort();
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (error) {
      // A key that was not there is already deleted.
      if (!isMissingFile(error)) throw error;
    }
  }

  pathFor(key: string): string {
    return join(this.root, ...key.split("/"));
  }
}

/** The provider a local directory policy names. */
function providerForLocalFs(policy: { readonly localDir?: string }): BoxObjectStoreProvider {
  return new LocalFsObjectStoreProvider(policy.localDir ?? "");
}

/** The provider the platform's own box store names, which needs the backend's auth. */
function providerForBoxStore(agentStore: AgentStoreClientDependencies): BoxObjectStoreProvider {
  invariant(agentStore.getAccessToken !== undefined && agentStore.getMachineId !== undefined, "slate-box-store v2 selected but no backend auth was provided");
  const serviceDeps: SlateBoxStoreServiceDependencies = { getAccessToken: agentStore.getAccessToken, getMachineId: agentStore.getMachineId };
  return new SlateBoxStoreServiceProvider(serviceDeps);
}

/** Which store this box uses, as the platform's own policy says. */
export function resolveBoxObjectStoreProvider(deps: { readonly env?: NodeJS.ProcessEnv; readonly agentStore: AgentStoreClientDependencies }): BoxObjectStoreProvider {
  const policy = getBoxStoreBackendPolicy(deps.env);
  switch (policy.kind) {
    case "local-fs":
      return providerForLocalFs(policy);
    case "slate-box-store-v2":
      return providerForBoxStore(deps.agentStore);
    case "agent-store":
      return new AgentStoreObjectStoreProvider(deps.agentStore);
  }
}

/** The prefix a key has to sit under, with its trailing slashes removed. */
function trimmedPrefix(keyPrefix: string): string {
  return keyPrefix.replace(/\/+$/, "");
}

/** Whether a key sits under a prefix: a prefix names a directory, never a partial name. */
export function isUnderPrefix(key: string, keyPrefix: string): boolean {
  return keyPrefix === "" || key.startsWith(`${trimmedPrefix(keyPrefix)}/`);
}

/** Every file under a directory, without following links out of it. */
export async function walkFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // A directory that is not there holds no files.
    if (isMissingFile(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(absolutePath, out);
    else if (entry.isFile()) out.push(absolutePath);
  }
}