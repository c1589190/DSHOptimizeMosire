/**
 * Resolve the preset's `@deepseek-ai/*` rows against the RUNNING DSH install.
 *
 * Why this exists: a workspace preset that names official plugins as bare
 * package names is resolved by the Loader from the composition directory
 * (`<package>/presets/<preset>/`). Workspace packages have no node_modules of
 * their own, so the rows only resolve through a symlink farm under
 * `<package>/node_modules/@deepseek-ai/`. Any absolute symlink into a DSH
 * installation is version-coupled: pnpm's global layout is content-addressed
 * (`.../global/v11/<hash>/...`) and an upgrade creates a new directory while
 * deleting the old one, leaving every link dangling and every preset row
 * failing with "never started".
 *
 * This module rebuilds the farm from the installation that is actually running
 * (resolved from `process.argv[1]`), on every Host activation. The link targets
 * are therefore always the current install; no machine-specific path is
 * committed or persisted.
 *
 * The resolution mirrors DSH's own `packageDirFromAnchor`: probe the require
 * search paths for a directory containing `<name>/package.json` instead of
 * `require.resolve(name/package.json)` (packages may not export their own
 * package.json).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Official peer scope used by preset rows. */
export const PEER_SCOPE = '@deepseek-ai'

/** File extensions a bundled composition can use. */
const COMPOSITION_EXTENSIONS = ['.cordis.yml', '.cordis.yaml']

/**
 * Candidate anchors for the running DSH installation, most trustworthy first.
 *
 * `process.argv[1]` is the `dsh` CLI entry (`.../@deepseek-ai/dsh/lib/bin.js`)
 * for `dsh web`, `dsh tui`, and `dsh headless`. Node resolves modules from the
 * realpath, so the symlinked launcher path is tried after its realpath.
 * `DSH_INSTALL_ANCHOR` is an explicit escape hatch for launchers that replace
 * argv (desktop builds).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string[]} [argv]
 * @returns {string[]} absolute file paths, de-duplicated
 */
export function hostAnchorCandidates(env = process.env, argv = process.argv) {
  const candidates = []
  const push = (value) => {
    if (typeof value !== 'string' || value.length === 0) return
    if (!candidates.includes(value)) candidates.push(value)
  }
  push(env.DSH_INSTALL_ANCHOR)
  if (typeof argv[1] === 'string' && argv[1].length > 0) {
    const entry = resolve(argv[1])
    push(entry)
    try {
      push(realpathSync(entry))
    } catch {
      // The launcher can be removed by an in-flight upgrade; the unresolved path may still resolve peers.
    }
  }
  return candidates
}

/**
 * Locate one package directory by probing require search paths.
 * @param {string} anchor absolute file path used as the resolution base
 * @param {string} packageName package name (`@scope/name`)
 * @returns {string|undefined} absolute package directory
 */
export function packageDirFromAnchor(anchor, packageName) {
  let paths
  try {
    paths = createRequire(anchor).resolve.paths(packageName)
  } catch {
    return undefined
  }
  for (const searchPath of paths ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Pick the first candidate that can resolve an official DSH package.
 * @param {string[]} candidates
 * @returns {{anchor: string, packageDir: string}|undefined}
 */
export function findHostAnchor(candidates = hostAnchorCandidates()) {
  for (const anchor of candidates) {
    // A launcher path can be a symlink whose *directory* contains only the dsh
    // package itself; requiring a peer package rejects that shape and keeps the
    // farm from being pruned to empty.
    for (const probe of ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-bash']) {
      const packageDir = packageDirFromAnchor(anchor, probe)
      if (packageDir !== undefined) return { anchor, packageDir }
    }
  }
  return undefined
}

/**
 * Resolve one official package from a host anchor to its real directory.
 * @param {string} anchor
 * @param {string} packageName
 * @returns {{name: string, dir: string}|undefined}
 */
export function resolveHostPeer(anchor, packageName) {
  const packageDir = packageDirFromAnchor(anchor, packageName)
  if (packageDir === undefined) return undefined
  let dir = packageDir
  try {
    dir = realpathSync(packageDir)
  } catch {
    // Keep the probed path when realpath is unavailable.
  }
  return { name: packageName, dir }
}

/** Recursively collect composition files below a directory. */
function compositionFiles(dir) {
  const files = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...compositionFiles(path))
    else if (entry.isFile() && COMPOSITION_EXTENSIONS.some((suffix) => entry.name.endsWith(suffix))) files.push(path)
  }
  return files.sort()
}

/**
 * Every official package name referenced by a workspace package.
 *
 * Scans both bundled compositions (`name: '@deepseek-ai/...'` rows, including
 * nested groups) and Host plugin imports (`import ... from '@deepseek-ai/...'`),
 * so a future direct import cannot silently reintroduce a missing link.
 * Subpaths collapse to their package root.
 * @param {string} packageRoot
 * @returns {string[]} sorted, unique package names
 */
export function requiredPeerNames(packageRoot) {
  const names = new Set()
  const add = (specifier) => {
    if (!specifier.startsWith(`${PEER_SCOPE}/`)) return
    const parts = specifier.split('/')
    if (parts.length < 2 || parts[1].length === 0) return
    // Documentation placeholders such as `@deepseek-ai/...` are not packages.
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(parts[1])) return
    names.add(`${PEER_SCOPE}/${parts[1]}`)
  }

  for (const file of compositionFiles(join(packageRoot, 'presets'))) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/^\s*(?:-\s+)?name:\s*['"]?(@deepseek-ai\/[^'"\s#]+)['"]?/gm)) add(match[1])
  }

  const libDir = join(packageRoot, 'lib')
  let entries = []
  try {
    entries = readdirSync(libDir, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const source = readFileSync(join(libDir, entry.name), 'utf8')
    for (const match of source.matchAll(/\b(?:from|import)\s*\(?\s*['"](@deepseek-ai\/[^'"]+)['"]/g)) add(match[1])
  }

  return [...names].sort()
}

/** Create or replace one directory symlink without following it. */
function replaceSymlink(linkPath, target) {
  let current
  try {
    current = readlinkSync(linkPath)
  } catch {
    current = undefined
  }
  if (current === target) return false
  rmSync(linkPath, { force: true, recursive: false })
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  return true
}

/**
 * Rebuild `<packageRoot>/node_modules/@deepseek-ai/` from the running install.
 *
 * Links are created only for `names` that resolve; links for unresolved names
 * are removed so a stale package cannot satisfy a row with the wrong version.
 * When `anchor` cannot be found this function must not prune: the existing farm
 * may still be the only working one, so the caller gets `synced: false`.
 * @param {{packageRoot: string, names: string[], anchor?: string}} options
 * @returns {{synced: boolean, anchor: string|null, farmDir: string, linked: string[], missing: string[], changed: string[], error?: string}}
 */
export function syncPeerFarm({ packageRoot, names, anchor }) {
  const farmDir = join(packageRoot, 'node_modules', PEER_SCOPE)
  const resolvedAnchor = anchor ?? null
  if (resolvedAnchor === null) {
    return {
      synced: false,
      anchor: null,
      farmDir,
      linked: [],
      missing: [...names],
      changed: [],
      error: 'running DSH install not found (process.argv[1] resolved no @deepseek-ai package)',
    }
  }

  mkdirSync(farmDir, { recursive: true })
  const linked = []
  const missing = []
  const changed = []
  const desired = new Set()
  for (const name of names) {
    const peer = resolveHostPeer(resolvedAnchor, name)
    if (peer === undefined) {
      missing.push(name)
      continue
    }
    const short = name.slice(PEER_SCOPE.length + 1)
    if (short.includes('/')) continue
    desired.add(short)
    const linkPath = join(farmDir, short)
    linked.push(name)
    if (replaceSymlink(linkPath, peer.dir)) changed.push(name)
  }

  let entries = []
  try {
    entries = readdirSync(farmDir)
  } catch {
    entries = []
  }
  if (linked.length === 0 && names.length > 0) {
    return {
      synced: false,
      anchor: resolvedAnchor,
      farmDir,
      linked,
      missing,
      changed,
      error: 'no peer resolved from the running DSH install; leaving the existing farm untouched',
    }
  }
  for (const entry of entries) {
    if (desired.has(entry)) continue
    const path = join(farmDir, entry)
    try {
      lstatSync(path)
    } catch {
      continue
    }
    rmSync(path, { force: true, recursive: true })
    changed.push(entry)
  }

  return { synced: true, anchor: resolvedAnchor, farmDir, linked, missing, changed }
}

/**
 * Fallback for launchers that replace `process.argv` (desktop builds, test
 * harnesses): find the `dsh` CLI entry of a running Host process on Linux.
 * @returns {string|undefined} absolute path of the running `.../dsh/lib/bin.js`
 */
export function runningDshAnchor() {
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
      if (match !== null) {
        const bin = join(match[1], 'lib', 'bin.js')
        try {
          return realpathSync(bin)
        } catch {
          return bin
        }
      }
    } catch {
      // Process vanished or is unreadable; continue.
    }
  }
  return undefined
}

/**
 * Resolve the farm for a package mounted from a module URL.
 * @param {string|URL} moduleUrl
 * @param {{env?: NodeJS.ProcessEnv, argv?: string[]}} [options]
 */
export function syncPackagePeerFarm(moduleUrl = import.meta.url, options = {}) {
  const modulePath = moduleUrl instanceof URL
    ? fileURLToPath(moduleUrl)
    : String(moduleUrl).startsWith('file:')
      ? fileURLToPath(moduleUrl)
      : String(moduleUrl)
  const packageRoot = dirname(dirname(modulePath))
  const candidates = hostAnchorCandidates(options.env ?? process.env, options.argv ?? process.argv)
  let host = findHostAnchor(candidates)
  if (host === undefined) {
    const running = runningDshAnchor()
    if (running !== undefined) host = findHostAnchor([running])
  }
  const names = requiredPeerNames(packageRoot)
  return syncPeerFarm({ packageRoot, names, anchor: host?.anchor })
}
