import { basename, dirname, extname, resolve } from "node:path";
import type { Context } from "../context/context.ts";
import type { LsIgnoreService, LsTraversalRuntime } from "./ls-contracts.ts";

const MAX_INT32_VALUE = 2 ** 31 - 1;

interface DirectoryTreeNode {
  absPath: string;
  childrenDirs: DirectoryTreeNode[];
  childrenFiles: Array<{ name: string }>;
  childrenWereProcessed: boolean;
  fullSubtreeExtensionCounts: Record<string, number>;
  numFiles?: number;
}

export interface DirectoryTreeNodeInit {
  readonly absPath: string;
  readonly childrenDirs: [];
  readonly childrenFiles: [];
  readonly childrenWereProcessed: boolean;
  readonly fullSubtreeExtensionCounts: Record<string, number>;
}

type DirectoryTreeNodeFactory = (init: DirectoryTreeNodeInit) => DirectoryTreeNode;

function boundedCount(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(-(2 ** 31), Math.min(MAX_INT32_VALUE, value));
}

function directoryNode(args: {
  readonly path: string;
  readonly completed: boolean;
  readonly makeNode: DirectoryTreeNodeFactory;
}): DirectoryTreeNode {
  return args.makeNode({
    absPath: args.path,
    childrenDirs: [],
    childrenFiles: [],
    childrenWereProcessed: args.completed,
    fullSubtreeExtensionCounts: {},
  });
}

function countUnlistedFile(filePath: string, root: string, directories: Map<string, DirectoryTreeNode>): void {
  const extension = extname(filePath);
  let current = dirname(filePath);
  while (current.startsWith(root)) {
    const node = directories.get(current);
    if (node !== undefined) {
      node.fullSubtreeExtensionCounts[extension] = boundedCount((node.fullSubtreeExtensionCounts[extension] ?? 0) + 1);
      node.numFiles = boundedCount((node.numFiles ?? 0) + 1);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function markBudgetExceeded(path: string, root: string, directories: Map<string, DirectoryTreeNode>): void {
  let current = path;
  while (current.startsWith(root)) {
    const node = directories.get(current);
    if (node !== undefined) node.childrenWereProcessed = false;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function ensureDirectory(
  path: string,
  root: string,
  directories: Map<string, DirectoryTreeNode>,
  createNode: DirectoryTreeNodeFactory,
  budgetExceeded: boolean,
): void {
  if (directories.has(path) || path === root) return;
  const parent = dirname(path);
  if (parent !== path && parent.startsWith(root)) ensureDirectory(parent, root, directories, createNode, budgetExceeded);
  const node = directoryNode({ path, completed: !budgetExceeded, makeNode: createNode });
  directories.set(path, node);
  directories.get(parent)?.childrenDirs.push(node);
}

function appendFilePath(args: {
  readonly filePath: string;
  readonly root: string;
  readonly directories: Map<string, DirectoryTreeNode>;
  readonly state: { charactersUsed: number; budgetExceeded: boolean };
  readonly characterBudget: number;
  readonly createDirectory: DirectoryTreeNodeFactory;
  readonly createFile: (name: string) => { name: string };
}): void {
  const name = basename(args.filePath);
  const directory = dirname(args.filePath);
  ensureDirectory(directory, args.root, args.directories, args.createDirectory, args.state.budgetExceeded);
  const parent = args.directories.get(directory);
  if (parent === undefined) return;

  if (!args.state.budgetExceeded && args.state.charactersUsed + name.length <= args.characterBudget) {
    parent.childrenFiles.push(args.createFile(name));
    args.state.charactersUsed += name.length;
    return;
  }
  if (!args.state.budgetExceeded) {
    args.state.budgetExceeded = true;
    markBudgetExceeded(directory, args.root, args.directories);
  }
  countUnlistedFile(args.filePath, args.root, args.directories);
}

function sortTree(node: DirectoryTreeNode): void {
  node.childrenDirs.sort((left, right) => basename(left.absPath).localeCompare(basename(right.absPath)));
  node.childrenFiles.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of node.childrenDirs) sortTree(child);
}

/** Build the tree from traversal output while keeping the generated tree-node constructors at the caller boundary. */
export async function buildLocalDirectoryTree<Node>(args: {
  readonly context: Context;
  readonly root: string;
  readonly ignoreGlobs: readonly string[];
  readonly sandboxPolicy: unknown;
  readonly characterBudget: number;
  readonly ignoreService: LsIgnoreService;
  readonly traversal: LsTraversalRuntime;
  readonly createDirectory: (init: DirectoryTreeNodeInit) => Node;
  readonly createFile: (name: string) => { name: string };
}): Promise<{ tree: Node; didTimeout: boolean }> {
  const root = resolve(args.root);
  const directories = new Map<string, DirectoryTreeNode>();
  const makeDirectory = args.createDirectory as DirectoryTreeNodeFactory;
  const tree = directoryNode({ path: root, completed: true, makeNode: makeDirectory });
  directories.set(root, tree);
  const state = { charactersUsed: root.length, budgetExceeded: false };
  const [workspaceIgnoreFiles, repositoryGlobs] = await Promise.all([
    args.ignoreService.listWorkspaceIgnoreFilesByRoot(args.root),
    args.ignoreService.getRepoBlockExcludeGlobs(args.root),
  ]);
  const walked = args.traversal.walk(args.context, {
    root: args.root,
    excludeGlobs: [...args.ignoreGlobs, ...repositoryGlobs],
    workspaceIgnoreFiles,
    ...(args.sandboxPolicy === undefined ? {} : { sandboxPolicy: args.sandboxPolicy }),
    source: "ls",
  });

  for await (const line of walked.lines) {
    if (!line) continue;
    const filePath = resolve(args.root, line);
    const resolvedForIgnore = await args.traversal.resolveForIgnore(filePath);
    if (resolvedForIgnore === null || await args.ignoreService.isRepoBlocked(resolvedForIgnore)) continue;
    appendFilePath({
      filePath,
      root,
      directories,
      state,
      characterBudget: args.characterBudget,
      createDirectory: makeDirectory,
      createFile: args.createFile,
    });
  }

  sortTree(tree);
  return { tree: tree as unknown as Node, didTimeout: await walked.didTimeout };
}
