import { cpSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(packageRoot, "dist");
const vendorRoot = join(outputRoot, "vendor");
const vendorPackages = [
  {
    name: "work-domain",
    source: resolve(packageRoot, "../../packages/work-domain/dist"),
    aliases: {
      "@slate/work-domain": "index.js",
      "@slate/work-domain/usage": "usage.js",
      "@slate/work-domain/widgets": "widgets.js",
    },
  },
  {
    name: "work-protocol",
    source: resolve(packageRoot, "../../packages/work-protocol/dist"),
    aliases: { "@slate/work-protocol": "index.js" },
  },
];

function copyTypescriptOutput(sourceDirectory, targetDirectory) {
  mkdirSync(targetDirectory, { recursive: true });
  for (const entry of readdirSync(sourceDirectory)) {
    const sourcePath = join(sourceDirectory, entry);
    const targetPath = join(targetDirectory, entry);
    if (statSync(sourcePath).isDirectory()) {
      copyTypescriptOutput(sourcePath, targetPath);
    } else if (entry.endsWith(".js") || entry.endsWith(".d.ts")) {
      cpSync(sourcePath, targetPath);
    }
  }
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const entryPath = join(directory, entry);
    if (statSync(entryPath).isDirectory()) files.push(...walk(entryPath));
    else if (entryPath.endsWith(".js") || entryPath.endsWith(".d.ts")) files.push(entryPath);
  }
  return files;
}

rmSync(vendorRoot, { recursive: true, force: true });
for (const vendorPackage of vendorPackages) {
  copyTypescriptOutput(vendorPackage.source, join(vendorRoot, vendorPackage.name));
}

for (const filePath of walk(outputRoot)) {
  const source = readFileSync(filePath, "utf8");
  const rewritten = source.replace(/(["'])(@slate\/(?:work-domain(?:\/(?:usage|widgets))?|work-protocol))\1/g, (match, quote, moduleName) => {
    const vendorPackage = vendorPackages.find((candidate) => Object.hasOwn(candidate.aliases, moduleName));
    if (vendorPackage === undefined) throw new Error(`Unmapped SDK module: ${moduleName}`);
    const vendorTarget = join(vendorRoot, vendorPackage.name, vendorPackage.aliases[moduleName]);
    let relativePath = relative(dirname(filePath), vendorTarget).replaceAll("\\", "/");
    if (!relativePath.startsWith(".")) relativePath = `./${relativePath}`;
    return `${quote}${relativePath}${quote}`;
  });
  if (rewritten !== source) writeFileSync(filePath, rewritten);
}
