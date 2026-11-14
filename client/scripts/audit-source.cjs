// Read-only TS entrypoint reachability. This does NOT classify tests, native resources or bundled assets as dead.
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const ENTRIES = ['main/index.ts', 'preload/index.ts', 'renderer/main.ts']
const RETAINED = {
  'main/sandbox/macos.ts': 'Native macOS isolation policy candidate, explicitly retained and tested; not Windows execution authority.',
  'main/tex/base-metadata.ts': 'Read-only TeX metadata verification utility with independent regression coverage; not compile authority.'
}
const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)

function sourceFiles(root) {
  const files = []
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('Source audit refuses symbolic links')
      const file = path.join(directory, item.name)
      if (item.isDirectory()) visit(file)
      else if (item.isFile() && /\.ts$/.test(item.name) && !/\.d\.ts$/.test(item.name)) files.push(file)
    }
  }
  visit(root)
  return files.sort()
}

function audit(root, entries = ENTRIES, retained = RETAINED) {
  root = path.resolve(root)
  const files = sourceFiles(root), byKey = new Map(files.map(file => [key(file), file]))
  const graph = new Map(), dynamicImports = [], syntaxErrors = []
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const edges = new Set()
    syntaxErrors.push(...source.parseDiagnostics.map(error => ({ file: relative(file), code: error.code })))
    function specifier(text) {
      if (!text.startsWith('.')) return
      const resolved = ts.resolveModuleName(text, file, { moduleResolution: ts.ModuleResolutionKind.Bundler }, ts.sys).resolvedModule
      if (resolved && byKey.has(key(resolved.resolvedFileName))) edges.add(key(resolved.resolvedFileName))
    }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        const arg = node.arguments[0]
        if (arg && ts.isStringLiteralLike(arg)) specifier(arg.text)
        else dynamicImports.push(relative(file))
      }
      ts.forEachChild(node, visit)
    }
    visit(source); graph.set(key(file), edges)
  }
  function relative(file) { return path.relative(root, file).split(path.sep).join('/') }
  const reached = new Set(), pending = entries.map(entry => key(path.join(root, entry)))
  const missingEntries = entries.filter(entry => !byKey.has(key(path.join(root, entry))))
  while (pending.length) {
    const current = pending.pop()
    if (reached.has(current) || !byKey.has(current)) continue
    reached.add(current); pending.push(...graph.get(current))
  }
  const unreachable = [], intentional = []
  for (const file of files) {
    if (reached.has(key(file))) continue
    const name = relative(file)
    if (typeof retained[name] === 'string' && retained[name].trim()) intentional.push({ path: name, reason: retained[name] })
    else unreachable.push(name)
  }
  return { ok: !unreachable.length && !dynamicImports.length && !missingEntries.length && !syntaxErrors.length,
    entries, sourceFiles: files.length, reachable: reached.size, retained: intentional, unreachable,
    dynamicImports: [...new Set(dynamicImports)], missingEntries, syntaxErrors,
    scope: 'Static TypeScript dependencies from the three real Electron/Vite entrypoints; no automatic deletion.',
    excluded: ['ambient .d.ts', 'test/script entrypoints', 'CSS/assets/workers', 'native binaries/runtime packages', 'historical evidence'] }
}

module.exports = { audit, ENTRIES, RETAINED }
if (require.main === module) {
  try {
    const report = audit(path.resolve(__dirname, '../src'))
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
