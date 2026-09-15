import { mkdir, readdir, readFile, writeFile, access } from "node:fs/promises"
import ts from 'typescript'
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const componentsDirectory = path.join(root, "components")
const outputFile = path.join(root, "stories", "generated", "component-inventory.json")

// The thinking playground contains an application bootstrap and its private
// demo-only children. They are useful as a demo story, but are not reusable
// OpenLink components and should not appear in the component catalog.
const nonReusableComponent = /^thinking\/demo(?:\/|$)/

async function collectComponentFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) return collectComponentFiles(absolutePath)
    if (!entry.isFile() || !entry.name.endsWith(".tsx") || entry.name.endsWith(".stories.tsx")) return []
    return [path.relative(componentsDirectory, absolutePath).replaceAll(path.sep, "/").replace(/\.tsx$/, "")]
  }))
  return files.flat()
}

const componentFiles = (await collectComponentFiles(componentsDirectory))
  .filter((module) => !nonReusableComponent.test(module))
  .sort((left, right) => left.localeCompare(right))
await mkdir(path.dirname(outputFile), { recursive: true })
await writeFile(outputFile, `${JSON.stringify(componentFiles, null, 2)}\n`, "utf8")
console.log(`Indexed ${componentFiles.length} OpenLink component modules.`)

// Record actual story entrypoints separately from a filename-only inventory.
const graph = new Map()
async function resolveImport(from, specifier) {
  const base = specifier.startsWith('@/') ? path.join(root, specifier.slice(2)) : specifier.startsWith('.') ? path.resolve(path.dirname(from), specifier) : null
  if (!base) return null
  for (const suffix of ['', '.tsx', '.ts', '/index.tsx', '/index.ts']) {
    const candidate = base + suffix
    if (!/\.(tsx?|jsx?)$/.test(candidate)) continue
    try { await access(candidate); return candidate } catch {}
  }
  return null
}
async function importsOf(file) {
  if (graph.has(file)) return graph.get(file)
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const imports = []
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (statement.isTypeOnly || (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly)) continue
    const target = await resolveImport(file, statement.moduleSpecifier.text)
    if (target) imports.push(target)
  }
  graph.set(file, imports)
  return imports
}
async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))).flat()
}
const storyFiles = [...await filesUnder(path.join(root, 'stories')), ...await filesUnder(componentsDirectory)].filter(file => file.endsWith('.stories.tsx'))
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const entrypoints = []
function objectValue(expression) {
  while (expression && (ts.isSatisfiesExpression(expression) || ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression))) expression = expression.expression
  return expression && ts.isObjectLiteralExpression(expression) ? expression : null
}
function stringProperty(object, key) {
  const property = object?.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText().replace(/['"]/g, '') === key)
  return property && ts.isStringLiteral(property.initializer) ? property.initializer.text : null
}

async function importBindings(file, source) {
  const bindings = new Map()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.isTypeOnly || !statement.importClause || statement.importClause.isTypeOnly) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    const target = await resolveImport(file, statement.moduleSpecifier.text)
    if (!target) continue
    const clause = statement.importClause
    if (clause.name) bindings.set(clause.name.text, target)
    if (!clause.namedBindings) continue
    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindings.set(clause.namedBindings.name.text, target)
      continue
    }
    for (const element of clause.namedBindings.elements) bindings.set(element.name.text, target)
  }
  return bindings
}

async function storyRecords(file, source, { title, id }) {
  const bindings = await importBindings(file, source)
  const declarations = source.statements
    .filter(statement => ts.isVariableStatement(statement) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
    .flatMap(statement => [...statement.declarationList.declarations])
  const records = []
  for (const declaration of declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
    const modules = new Set()
    const collect = node => {
      if (ts.isIdentifier(node) && bindings.has(node.text)) modules.add(bindings.get(node.text))
      node.forEachChild(collect)
    }
    collect(declaration.initializer)
    const reachable = new Set()
    const visit = async target => {
      if (reachable.has(target)) return
      reachable.add(target)
      for (const next of await importsOf(target)) await visit(next)
    }
    for (const target of modules) await visit(target)
    const name = declaration.name.text
    records.push({
      name,
      id: `${id ?? slug(title)}--${slug(name.replace(/([a-z0-9])([A-Z])/g, '$1-$2'))}`,
      modules,
      reachable,
    })
  }
  return records
}

for (const file of storyFiles) {
  const text = await readFile(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const defaultExport = source.statements.find(statement => ts.isExportAssignment(statement))?.expression
  const declarations = source.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
  const metadata = objectValue(defaultExport && ts.isIdentifier(defaultExport) ? declarations.find(declaration => declaration.name.getText(source) === defaultExport.text)?.initializer : defaultExport)
  const title = stringProperty(metadata, 'title')
  if (!title) continue
  const direct = new Set(await importsOf(file))
  const reachable = new Set()
  async function visit(target) {
    if (reachable.has(target)) return
    reachable.add(target)
    for (const next of await importsOf(target)) await visit(next)
  }
  for (const target of direct) await visit(target)
  entrypoints.push({ file: path.relative(root, file), title, stories: await storyRecords(file, source, { title, id: stringProperty(metadata, 'id') }), direct, reachable })
}
const coverage = componentFiles.map(module => {
  const absolute = path.join(componentsDirectory, `${module}.tsx`)
  const direct = entrypoints.filter(entry => entry.direct.has(absolute))
  const composed = entrypoints.filter(entry => entry.reachable.has(absolute))
  const entries = direct.length ? direct : composed
  return {
    module,
    status: direct.length ? 'direct' : composed.length ? 'composition' : 'missing',
    reason: null,
    entries: entries.map(({ title, file, stories }) => {
      const matchingStories = stories.filter(story => story.modules.has(absolute) || story.reachable.has(absolute))
      const selectedStories = matchingStories.length ? matchingStories : stories
      return { title, file, stories: selectedStories.map(({ name, id }) => ({ name, id })) }
    }),
  }
})
const report = { modules: coverage.length, stories: entrypoints.reduce((sum, entry) => sum + entry.stories.length, 0), direct: coverage.filter(row => row.status === 'direct').length, composition: coverage.filter(row => row.status === 'composition').length, missing: coverage.filter(row => row.status === 'missing').map(row => row.module), coverage }
await writeFile(path.join(root, 'stories/generated/component-coverage.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`Story coverage: ${report.direct} direct, ${report.composition} via composition, ${report.stories} stories. Missing: ${report.missing.join(', ') || 'none'}`)
if (process.argv.includes('--check') && report.missing.length) process.exitCode = 1
