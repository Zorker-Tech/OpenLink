import path from "node:path";

function searchPathVariable(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const aliases = Object.keys(environment).filter((name) => name.toLowerCase() === "path");
  if (aliases.length === 0) return undefined;
  const preferred = platform === "win32" ? "Path" : "PATH";
  return aliases.find((name) => name === preferred) ?? aliases[0];
}

export function prependExecutableDirectory(
  environment: NodeJS.ProcessEnv,
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const parent = platform === "win32"
    ? path.win32.dirname(executablePath)
    : path.posix.dirname(executablePath);
  if (parent.length === 0 || parent === ".") return environment;

  const variable = searchPathVariable(environment, platform)
    ?? (platform === "win32" ? "Path" : "PATH");
  const delimiter = platform === "win32" ? ";" : ":";
  const existing = (environment[variable] ?? "").split(delimiter).filter(Boolean);
  const updated = [parent, ...existing.filter((entry) => entry !== parent)].join(delimiter);
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    if (name !== variable && name.toLowerCase() === "path") delete result[name];
  }
  result[variable] = updated;
  return result;
}
