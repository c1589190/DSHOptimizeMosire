#!/usr/bin/env node
/**
 * link-dsh-peers — materialize every official `@deepseek-ai/*` package that a
 * workspace package references as a symlink to the running DSH installation.
 *
 * WHY: workspace packages under `packages/` have no node_modules of their own,
 * so a bare `@deepseek-ai/<pkg>` import (Host plugin code) or a bare package
 * name in a bundled preset composition (any `*.cordis.yml` below
 * `<package>/presets/`, loaded by `@deepseek-ai/cordis-plugin-include` with the
 * composition directory as its baseUrl) would not resolve. Symlinking to the
 * DSH installation keeps module realpaths identical, so the harness and the
 * workspace package share one module instance of each plugin package.
 *
 * WHAT IS SCANNED, per package directory under `packages/`:
 *   (a) every `import` / `export ... from` / dynamic `import()` specifier in
 *       `<package>/lib/*.js`, and
 *   (b) every `name: '@deepseek-ai/<pkg>'` row in every
 *       `<package>/presets/**` composition file.
 * Only the scoped package root is used; subpaths are dropped.
 *
 * Usage: node tools/link-dsh-peers.mjs [--dsh-root <path>]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const packagesRoot = join(repoRoot, 'packages')

/** Every quoted module specifier introduced by import/export syntax. */
function importSpecifiers(source) {
  const specifiers = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g, // import ... from '<spec>' / export * from '<spec>'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('<spec>')
    /\bimport\s+['"]([^'"]+)['"]/g, // side-effect import '<spec>'
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  }
  return specifiers
}

/** Every official package named by one composition file. */
function compositionNames(source) {
  return [...source.matchAll(/^\s*name:\s*['"]?(@deepseek-ai\/[^'"\s#]+)['"]?/gm)].map((match) => match[1])
}

/** Add the scoped package root of one specifier to a name set. */
function addPackageName(names, specifier) {
  if (!specifier.startsWith('@deepseek-ai/')) return
  names.add(specifier.split('/').slice(0, 2).join('/'))
}

/** Recursively collect files below a directory that match one suffix. */
function filesWithSuffix(dir, suffix) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...filesWithSuffix(path, suffix))
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path)
  }
  return files.sort()
}

/** Official package names referenced by one workspace package. */
function referencedNames(packageDir) {
  const names = new Set()

  const libDir = join(packageDir, 'lib')
  if (existsSync(libDir)) {
    for (const file of readdirSync(libDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.js')) continue
      for (const specifier of importSpecifiers(readFileSync(join(libDir, file.name), 'utf8'))) {
        addPackageName(names, specifier)
      }
    }
  }

  const presetsDir = join(packageDir, 'presets')
  if (existsSync(presetsDir)) {
    for (const file of filesWithSuffix(presetsDir, '.cordis.yml')) {
      for (const specifier of compositionNames(readFileSync(file, 'utf8'))) addPackageName(names, specifier)
    }
  }

  return [...names].sort()
}

/**
 * Find the running DSH installation's package directory.
 *
 * DSH installs two layouts in practice:
 *  - npm-style: `<install>/node_modules/@deepseek-ai/dsh`, with peers nested at
 *    `<dsh>/node_modules/@deepseek-ai/*`;
 *  - pnpm-style: `<global>/node_modules/@deepseek-ai/dsh` (a symlink into
 *    `.pnpm/...`), with peers as SIBLINGS of the dsh package under the same
 *    `@deepseek-ai/` directory.
 * The peer source is therefore either the nested path or the dsh package's
 * parent; pick whichever actually contains an official peer package.
 */
function peerSourceRoot(dshRoot) {
  let realRoot = dshRoot
  try {
    realRoot = realpathSync(dshRoot)
  } catch {
    // Keep the unresolved path; candidates below still degrade usefully.
  }
  const candidates = [
    join(realRoot, 'node_modules', '@deepseek-ai'),
    dirname(realRoot),
    join(dshRoot, 'node_modules', '@deepseek-ai'),
    dirname(dshRoot),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'dsh-persona', 'package.json'))) return candidate
  }
  return candidates.find((candidate) => existsSync(candidate))
}

/** Locate the running `dsh` Host process on Linux via /proc (preferred). */
function runningDshRoot() {
  if (process.platform !== 'linux') return undefined
  let pids
  try {
    pids = readdirSync('/proc')
  } catch {
    return undefined
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      const match = /(\/[^\0 ]*?\/node_modules\/@deepseek-ai\/dsh)\/lib\/bin\.js/.exec(cmdline)
      if (match) return match[1]
    } catch {
      // Process vanished or is unreadable; continue.
    }
  }
  return undefined
}

/** Fallback: the newest @deepseek-ai/dsh package under the pnpm global store. */
function pnpmGlobalDshRoot() {
  const home = process.env.HOME
  if (home === undefined) return undefined
  const globalDir = join(home, '.local', 'share', 'pnpm', 'global', 'v11')
  let entries
  try {
    entries = readdirSync(globalDir)
  } catch {
    return undefined
  }
  let best
  for (const entry of entries) {
    const candidate = join(globalDir, entry, 'node_modules', '@deepseek-ai', 'dsh')
    try {
      if (!existsSync(join(candidate, 'package.json'))) continue
      const mtime = statSync(join(candidate, 'package.json')).mtimeMs
      if (best === undefined || mtime > best.mtime) best = { candidate, mtime }
    } catch {
      // ignore unreadable store entry
    }
  }
  return best?.candidate
}

const argIndex = process.argv.indexOf('--dsh-root')
let dshRoot = argIndex >= 0 ? process.argv[argIndex + 1] : undefined
if (dshRoot === undefined) dshRoot = runningDshRoot() ?? pnpmGlobalDshRoot() ?? (() => {
  const require = createRequire(import.meta.url)
  try {
    return dirname(require.resolve('@deepseek-ai/dsh/package.json', { paths: [process.cwd(), '/usr/local/lib/node_modules'] }))
  } catch {
    return undefined
  }
})()
if (dshRoot === undefined) {
  console.error('link-dsh-peers: cannot locate the DSH installation; pass --dsh-root <.../@deepseek-ai/dsh>')
  process.exit(1)
}
const sourceRoot = peerSourceRoot(dshRoot)
if (sourceRoot === undefined) {
  console.error(`link-dsh-peers: no @deepseek-ai peer packages found for ${dshRoot}; pass --dsh-root <.../@deepseek-ai/dsh>`)
  process.exit(1)
}

const packageNames = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, 'package.json')))
  .map((entry) => entry.name)
  .sort()

const summary = []
for (const packageName of packageNames) {
  const packageDir = join(packagesRoot, packageName)
  const names = referencedNames(packageDir)
  const missing = []
  let linked = 0

  if (names.length > 0) {
    const targetRoot = join(packageDir, 'node_modules', '@deepseek-ai')
    mkdirSync(targetRoot, { recursive: true })
    for (const name of names) {
      const shortName = name.split('/')[1]
      const source = join(sourceRoot, shortName)
      const target = join(targetRoot, shortName)
      if (!existsSync(source)) {
        missing.push(name)
        continue
      }
      rmSync(target, { recursive: true, force: true })
      symlinkSync(source, target, 'dir')
      linked += 1
    }
  }

  summary.push({ package: packageName, linked, missing })
}

console.log(JSON.stringify({ dshRoot, packages: summary }, null, 2))
