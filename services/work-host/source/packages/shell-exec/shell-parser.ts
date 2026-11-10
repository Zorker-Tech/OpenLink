/**
 * Reading a shell command well enough to decide whether it is safe to allow.
 *
 * A command is not a string: it is a program with words, arguments, redirections, substitutions and pipes,
 * and a policy that decides what may run has to see those parts rather than guess at them. So the command is
 * parsed by a real bash parser, and the parse is read twice over: once into the older, coarser shape — the
 * simple commands, whether anything is redirected — and once into the structured shape the sandbox uses,
 * where each redirection is classified by what it points at. A redirection is only safe when what it writes
 * to is nothing at all: the terminal it was given or the null device. A heredoc is safe when the command
 * reading it is known and it is not inside a substitution, since a substitution's contents are a command of
 * their own.
 *
 * The parser is a native module, and native modules are the part of a packaged application that goes wrong:
 * they are built against one ABI and loaded in another, and the failure is a crash rather than an error. So
 * the loading is explicit about where it may look — the staged dependencies of a packaged build, or the
 * developer's own installation — and a native load failure is terminal rather than retried in another domain,
 * because a parser from the wrong domain would parse the command with the wrong grammar. A build whose
 * natives were replaced by a stub reports itself, and the analysis then degrades to saying it failed rather
 * than pretending the command was simple.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type ParserType from "tree-sitter";

type ParserConstructor = typeof ParserType;


/** The module loader the runtime dependencies are read with: this module's own tree, at runtime. */
const moduleRequire = createRequire(
  typeof import.meta.url === "string"
    ? import.meta.url
    : pathToFileURL(typeof __filename === "string" ? __filename : path.join(process.cwd(), "package.json")).href,
);

/** The root a package may be staged under, when the runtime names one. */
function configuredDependencyRoot(): string | undefined {
  const configured = process.env.SLATE_TREE_SITTER_NODE_DEPS?.trim();
  return configured ? path.resolve(configured) : undefined;
}

/** The roots a packaged Electron build stages its native packages under. */
function electronDependencyRoots(): readonly string[] {
  const resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
  if (resourcesPath === undefined) return [];
  return [
    path.join(resourcesPath, "app.asar.unpacked", "dist", "deps"),
    path.join(resourcesPath, "dist", "deps"),
  ];
}

/** The directory a packaged plain-Node build stages its native packages beside. */
function packagedDependencyRoots(): readonly string[] {
  const configured = configuredDependencyRoot();
  if (configured !== undefined) return [configured];
  const bundleDirectory = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  return [path.resolve(bundleDirectory, "..", "node-deps")];
}

/** Every root the runtime dependencies may be read from, in the order they are tried. */
function runtimeDependencyRoots(): readonly string[] {
  if (process.env.SLATE_PACKAGED !== "1") {
    // A configured root is an explicit developer/test resolution path. It is
    // deliberately not accepted as an override for a packaged Electron load.
    const developerRoot = configuredDependencyRoot();
    return developerRoot === undefined ? [] : [developerRoot];
  }
  if (process.versions.electron !== undefined) return electronDependencyRoots();
  return packagedDependencyRoots();
}

/** Which staged domain this process belongs to, as the failure message names it. */
function runtimeDependencyDomain(): "electron dist/deps" | "node dist/node-deps" | "developer" {
  if (process.env.SLATE_PACKAGED !== "1") return "developer";
  return process.versions.electron !== undefined ? "electron dist/deps" : "node dist/node-deps";
}

/** The error a native runtime dependency that cannot be loaded is reported with. */
function runtimeDependencyError(name: string, roots: readonly string[], cause?: unknown): Error {
  const domain = runtimeDependencyDomain();
  const searched = roots.length === 0 ? "<no staged root>" : roots.join(", ");
  const loaderDetail = cause instanceof Error ? ` Loader error: ${cause.message}` : "";
  const error = new Error(
    `shell-parser: cannot load ${name} from the ${domain} runtime domain (searched ${searched}). `
      + "The ABI-specific tree-sitter packages are missing or incompatible; rebuild and stage the matching runtime, "
      + "and refusing cross-ABI fallback." + loaderDetail,
  );
  Object.assign(error, {
    code: "SLATE_TREE_SITTER_RUNTIME_UNAVAILABLE",
    dependency: name,
    domain,
    roots: [...roots],
    cause,
  });
  return error;
}

/** Loads one native dependency from the developer installation this module was resolved through. */
function loadDeveloperDependency<Dependency>(name: string): Dependency {
  // This path is available only outside a packaged runtime.
  const resolvedPath = moduleRequire.resolve(name);
  return moduleRequire(resolvedPath) as Dependency;
}

/** Loads one native dependency from the staged root of the runtime domain this process belongs to. */
function loadRuntimeDependency<Dependency>(name: string): Dependency {
  const roots = runtimeDependencyRoots();
  if (process.env.SLATE_PACKAGED !== "1" && roots.length === 0) return loadDeveloperDependency<Dependency>(name);

  for (const root of roots) {
    const packageDirectory = path.join(root, name);
    if (!existsSync(path.join(packageDirectory, "package.json"))) continue;
    try {
      return moduleRequire(packageDirectory) as Dependency;
    } catch (cause: unknown) {
      // A native load failure is terminal; never retry another ABI domain or
      // the developer's root node_modules.
      throw runtimeDependencyError(name, roots, cause);
    }
  }
  throw runtimeDependencyError(name, roots);
}

const TreeSitterParser = loadRuntimeDependency<ParserConstructor>("tree-sitter");
const bashGrammar = loadRuntimeDependency<unknown>("tree-sitter-bash");

export interface ShellCommandArgument {
  readonly type: string;
  readonly value: string;
}

export interface ShellExecutableCommand {
  readonly name: string;
  readonly args: readonly ShellCommandArgument[];
  readonly fullText: string;
}

export interface ShellRedirect {
  readonly operator: string;
  readonly destinationFds: readonly number[];
  readonly targetNodeType: string;
  readonly targetText?: string;
}

export interface ShellCommandParsingResult {
  readonly parsingFailed: boolean;
  readonly executableCommands: readonly ShellExecutableCommand[];
  readonly hasRedirects: boolean;
  readonly hasCommandSubstitution: boolean;
  readonly allRedirectsAreDevNull?: boolean;
  readonly redirects: readonly ShellRedirect[];
}

export interface LegacyShellCommandAnalysis {
  readonly simpleCommands: readonly string[];
  readonly hasInputRedirect: boolean;
  readonly hasOutputRedirect: boolean;
}

export interface ShellCommandAnalysis {
  readonly legacy: LegacyShellCommandAnalysis;
  readonly structured: ShellCommandParsingResult;
}

export const TREE_SITTER_STUBBED_ERROR_CODE = "SLATE_TREE_SITTER_STUBBED";

/** The parser the module shares, once it has been built: nothing until then, and null for a stubbed build. */
let moduleParser: ParserType | null | undefined;

function isStubbedTreeSitterError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === TREE_SITTER_STUBBED_ERROR_CODE;
}

/** The shared parser, built on first use; a stubbed native build degrades the analysis instead of crashing it. */
function getParser(): ParserType | null {
  if (moduleParser !== undefined) return moduleParser;
  try {
    const parser = new TreeSitterParser();
    parser.setLanguage(bashGrammar);
    moduleParser = parser;
  } catch (error: unknown) {
    if (!isStubbedTreeSitterError(error)) throw error;
    moduleParser = null;
    console.warn("shell-parser: tree-sitter natives are unavailable in this artifact; shell command analysis degrades to parsingFailed");
  }
  return moduleParser;
}

/** The node types a redirect is written as. */
const REDIRECT_TYPES = new Set([
  "file_redirect",
  "heredoc_redirect",
  "herestring_redirect",
  "heredoc",
  "here_string",
  "redirect",
  "redirection",
]);

/** The operators a file redirection is written with. */
const REDIRECT_OPERATOR_TYPES = new Set([
  "<",
  ">",
  ">>",
  ">|",
  "<>",
  "<&",
  ">&",
  "&>",
  "&>>",
]);

/** The analysis of a command that could not be parsed at all. */
function commandParsingFailedAnalysis(): ShellCommandAnalysis {
  return {
    legacy: {
      simpleCommands: [],
      hasInputRedirect: false,
      hasOutputRedirect: false,
    },
    structured: {
      parsingFailed: true,
      executableCommands: [],
      hasRedirects: false,
      hasCommandSubstitution: false,
      redirects: [],
    },
  };
}

/** A file descriptor as a number, when the node is one. */
function fileDescriptorNumber(node: ParserType.SyntaxNode | undefined): number | undefined {
  if (!node || !/^\d+$/.test(node.text)) return undefined;
  return Number.parseInt(node.text, 10);
}

/** The file descriptor a redirect names in front of its operator, when it names one. */
function explicitFileDescriptor(node: ParserType.SyntaxNode): number | undefined {
  return fileDescriptorNumber(node.children.find((child) => child.type === "file_descriptor"));
}

/** The operator and target of a file redirection: the first operator child, and the first non-comment child after it. */
function fileRedirectParts(node: ParserType.SyntaxNode): { operator: string; target: ParserType.SyntaxNode | undefined } | undefined {
  const operatorIndex = node.children.findIndex((child) => REDIRECT_OPERATOR_TYPES.has(child.type));
  if (operatorIndex === -1) return undefined;
  return {
    operator: node.children[operatorIndex]?.type ?? "",
    target: node.children.slice(operatorIndex + 1).find((child) => child.type !== "comment"),
  };
}

/** The command a heredoc redirect belongs to, when its statement is a redirected command. */
function heredocReceiverCommandName(node: ParserType.SyntaxNode): string | undefined {
  const statement = node.parent;
  if (statement?.type !== "redirected_statement") return undefined;
  const commandNode = statement.children.find((child) => child.type === "command");
  return commandNode?.childForFieldName("name")?.text;
}

/** Whether the node sits in a command substitution that is not only a string's contents. */
function insideUnquotedCommandSubstitution(node: ParserType.SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "command_substitution" && current.parent?.type !== "string") return true;
    current = current.parent;
  }
  return false;
}

/** Whether the target node is exactly the null device, however it was quoted. */
function isNullDeviceTarget(node: ParserType.SyntaxNode | undefined): boolean {
  if (!node) return false;
  if (node.type === "word") return node.text === "/dev/null";
  if (node.type === "raw_string") return node.text === "'/dev/null'";
  if (node.type === "string") {
    const namedChildren = node.namedChildren;
    return namedChildren.length === 1 && namedChildren[0]?.type === "string_content" && namedChildren[0].text === "/dev/null";
  }
  return false;
}

/** The text of a redirect target the parser can read statically, if it can. */
function staticRedirectTargetText(node: ParserType.SyntaxNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "word") return node.namedChildren.length === 0 ? node.text : undefined;
  if (node.type === "number") return node.text;
  if (node.type === "raw_string") return node.text.length < 2 ? undefined : node.text.slice(1, -1);
  if (node.type === "string") {
    const namedChildren = node.namedChildren;
    if (namedChildren.length === 0 || namedChildren.some((child) => child.type !== "string_content")) return undefined;
    return namedChildren.map((child) => child.text).join("");
  }
  return undefined;
}

/** Whether a stream the redirect could land on is one the policy allows writing over. */
function isAllowlistSafeOutputTarget(target: string | undefined): boolean {
  return target === "original-stdout" || target === "original-stderr" || target === "dev-null";
}

/** The destination file descriptors a redirection move applies to. */
function redirectDestinationFds(node: ParserType.SyntaxNode, operator: string): number[] {
  if (operator === "&>" || operator === "&>>") return [1, 2];
  const explicitFd = explicitFileDescriptor(node);
  if (explicitFd !== undefined) return [explicitFd];
  return operator.startsWith("<") ? [0] : [1];
}

/** What each file descriptor currently points at, starting from the process's own streams. */
interface RedirectTrail {
  readonly fdTargets: Map<number, string>;
}

function newRedirectTrail(): RedirectTrail {
  return {
    fdTargets: new Map([
      [0, "original-stdin"],
      [1, "original-stdout"],
      [2, "original-stderr"],
    ]),
  };
}

export function analyzeShellCommand(rawCommand: string): ShellCommandAnalysis {
  const parser = getParser();
  if (parser === null) return commandParsingFailedAnalysis();

  const tree = parser.parse(rawCommand);
  const visitedRedirectNodes = new WeakSet<ParserType.SyntaxNode>();
  let sawRedirect = false;
  let allRedirectsAreAllowlistSafe = true;
  const simpleCommands: string[] = [];
  let hasInputRedirect = false;
  let hasOutputRedirect = false;
  let parsingFailed = false;
  const executableCommands: ShellExecutableCommand[] = [];
  let hasRedirects = false;
  let hasCommandSubstitution = false;
  let allRedirectsAreDevNull: boolean | undefined;
  const redirects: ShellRedirect[] = [];

  const noteRedirect = (isAllowlistSafe: boolean): void => {
    sawRedirect = true;
    hasRedirects = true;
    allRedirectsAreAllowlistSafe = allRedirectsAreAllowlistSafe && isAllowlistSafe;
  };

  /** Marks the coarse redirect flags from the text of a redirect node. */
  const markLegacyRedirectText = (text: string): void => {
    if (/(^|\s)[0-9]*<<?<?/.test(text)) hasInputRedirect = true;
    if (/(^|\s)[0-9]*>>/.test(text) || /(^|\s)[0-9]*>(\||&)?/.test(text) || /(^|\s)&>/.test(text) || /(^|\s)[0-9]+>&[0-9]+/.test(text)) {
      hasOutputRedirect = true;
    }
  };

  const markLegacyRedirectFields = (node: ParserType.SyntaxNode): void => {
    markLegacyRedirectText(node.text);
    if (node.type === "heredoc_redirect" || node.type === "herestring_redirect") hasInputRedirect = true;
  };

  const classifyHeredocRedirect = (node: ParserType.SyntaxNode): { redirect: ShellRedirect; isAllowlistSafe: boolean } => {
    const receiverCommandName = heredocReceiverCommandName(node);
    const isAllowlistSafe = receiverCommandName !== undefined && !insideUnquotedCommandSubstitution(node);
    return {
      isAllowlistSafe,
      redirect: {
        operator: isAllowlistSafe ? "<<" : "",
        destinationFds: isAllowlistSafe ? [0] : [],
        targetNodeType: node.type,
        ...(isAllowlistSafe ? { targetText: receiverCommandName } : {}),
      },
    };
  };

  /** Classifies one file redirect and records where its destinations now point. */
  const classifyFileRedirect = (node: ParserType.SyntaxNode, trail: RedirectTrail): boolean => {
    const parts = fileRedirectParts(node);
    if (!parts) return false;
    const { operator, target } = parts;
    const destinationFds = redirectDestinationFds(node, operator);
    const targetText = staticRedirectTargetText(target);
    redirects.push({
      operator,
      destinationFds,
      targetNodeType: target?.type ?? "",
      ...(targetText !== undefined ? { targetText } : {}),
    });
    if (operator === ">&") {
      const sourceFd = fileDescriptorNumber(target);
      const sourceTarget = sourceFd === undefined ? undefined : trail.fdTargets.get(sourceFd);
      if (!isAllowlistSafeOutputTarget(sourceTarget)) {
        for (const fd of destinationFds) trail.fdTargets.set(fd, "unsafe");
        return false;
      }
      for (const fd of destinationFds) trail.fdTargets.set(fd, sourceTarget!);
      return true;
    }
    if (operator === "<&") {
      const sourceFd = fileDescriptorNumber(target);
      const sourceTarget = sourceFd === undefined ? undefined : trail.fdTargets.get(sourceFd);
      if (sourceTarget !== "dev-null") {
        for (const fd of destinationFds) trail.fdTargets.set(fd, "unsafe");
        return false;
      }
      for (const fd of destinationFds) trail.fdTargets.set(fd, sourceTarget);
      return true;
    }
    if (!isNullDeviceTarget(target)) {
      for (const fd of destinationFds) trail.fdTargets.set(fd, "unsafe");
      return false;
    }
    for (const fd of destinationFds) trail.fdTargets.set(fd, "dev-null");
    return true;
  };

  /** Visits one redirect node: records it, classifies it and notes whether it was allowed. */
  const visitRedirect = (node: ParserType.SyntaxNode, trail: RedirectTrail): void => {
    if (visitedRedirectNodes.has(node)) return;
    visitedRedirectNodes.add(node);
    markLegacyRedirectFields(node);
    if (node.type === "heredoc_redirect") {
      const { redirect, isAllowlistSafe } = classifyHeredocRedirect(node);
      redirects.push(redirect);
      noteRedirect(isAllowlistSafe);
      return;
    }
    if (node.type !== "file_redirect") {
      redirects.push({ operator: "", destinationFds: [], targetNodeType: node.type });
      noteRedirect(false);
      return;
    }
    noteRedirect(classifyFileRedirect(node, trail));
  };

  /** Visits the redirect children one node carries directly, sharing one trail across them. */
  const visitChildRedirects = (node: ParserType.SyntaxNode): void => {
    const trail = newRedirectTrail();
    for (const child of node.children) {
      if (REDIRECT_TYPES.has(child.type)) visitRedirect(child, trail);
    }
  };

  const visitNode = (node: ParserType.SyntaxNode): void => {
    const nodeType = node.type;
    visitChildRedirects(node);
    if (REDIRECT_TYPES.has(nodeType) && !visitedRedirectNodes.has(node)) visitRedirect(node, newRedirectTrail());
    if (nodeType === "command") {
      const commandName = node.childForFieldName("name");
      if (commandName === null) {
        parsingFailed = true;
      } else {
        simpleCommands.push(commandName.text);
        let commandFullText = commandName.text;
        const commandArgs: ShellCommandArgument[] = [];
        for (const arg of node.childrenForFieldName("argument")) {
          commandArgs.push({ type: arg.type, value: arg.text });
          commandFullText += ` ${arg.text}`;
        }
        executableCommands.push({ name: commandName.text, args: commandArgs, fullText: commandFullText });
      }
    }
    if (nodeType === "command_name" || nodeType === "simple_command") {
      if (nodeType === "command_name" && !simpleCommands.includes(node.text)) {
        simpleCommands.push(node.text);
      } else if (nodeType === "simple_command") {
        const firstChild = node.firstNamedChild;
        if (firstChild && firstChild.type === "command_name") {
          if (!simpleCommands.includes(firstChild.text)) simpleCommands.push(firstChild.text);
        } else {
          simpleCommands.push(node.text);
        }
      }
    }
    if (nodeType === "command_substitution" || nodeType === "process_substitution") hasCommandSubstitution = true;
    for (const child of node.children) visitNode(child);
  };

  visitNode(tree.rootNode);
  const structured = { parsingFailed, executableCommands, hasRedirects, hasCommandSubstitution, redirects };
  if (sawRedirect) {
    // The property is appended after the rest, which is the order the analysis has always carried.
    return {
      legacy: { simpleCommands, hasInputRedirect, hasOutputRedirect },
      structured: { ...structured, allRedirectsAreDevNull: allRedirectsAreAllowlistSafe },
    };
  }
  return {
    legacy: { simpleCommands, hasInputRedirect, hasOutputRedirect },
    structured,
  };
}