#!/usr/bin/env node
/**
 * doctor — check (and optionally repair) the machine-local install of dshom.
 *
 * DSH upgrades rewrite the global install directory, and profile package
 * operations can drop a bundle entry from `dsh.profile.bundles`. Neither is a
 * property of our source tree, so this script verifies the three machine-local
 * couplings and repairs the two that are safe to rewrite:
 *
 *   1. the profile uses either the all-in-one `@mosire/dshom` bundle or the
 *      split layout (preset bundle + one bundle per feature), and every listed
 *      bundle is a dependency with a resolvable patch;
 *   2. the preset peer farm resolves every `@deepseek-ai/*` row against the
 *      RUNNING DSH install (the Host plugin also refreshes it on every boot);
 *   3. the last preset declaration recorded `broken: null`.
 *
 * Usage:
 *   node tools/doctor.mjs [--profile web] [--fix]
 */
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findHostAnchor,
  requiredPeerNames,
  resolveHostPeer,
  runningDshAnchor,
  syncPackagePeerFarm,
} from '../packages/dsh-liangshen-anchored/lib/host-peers.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const presetRoot = join(repoRoot, 'packages', 'dsh-liangshen-anchored')
const args = process.argv.slice(2)
const fix = args.includes('--fix')
const profileIndex = args.indexOf('--profile')
const profile = profileIndex >= 0 ? args[profileIndex + 1] : process.env.DSH_PROFILE ?? 'web'
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const manifestPath = join(profileDir, 'package.json')
const statusPath = join(dshHome, 'liangshen-anchored-status.json')

const problems = []
const fixes = []
const notes = []

/** Read the profile manifest, or fail with an actionable message. */
function readManifest() {
  if (!existsSync(manifestPath)) {
    console.error(`doctor: no profile manifest at ${manifestPath}; start dsh once and retry`)
    process.exit(2)
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

/** Atomically replace the profile manifest without reordering unrelated fields. */
function writeManifest(manifest) {
  const temp = `${manifestPath}.dshom-${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(manifest, void 0, 2)}\n`, { mode: 0o600 })
  renameSync(temp, manifestPath)
}

const manifest = readManifest()
const dependencies = manifest.dependencies ?? {}
const bundles = manifest.dsh?.profile?.bundles ?? []

/** Split layout: one profile bundle per feature, plus the preset bundle. */
const SPLIT_BUNDLES = [
  '@mosire/dsh-liangshen-anchored',
  '@mosire/dsh-goal-confirm',
  '@mosire/dsh-subagent-access',
  '@mosire/dsh-job-tools',
  '@mosire/dsh-session-import',
  '@mosire/dsh-prompt-lab-session',
  '@mosire/dsh-session-inspect',
]
const splitListed = SPLIT_BUNDLES.filter((name) => bundles.includes(name))
const splitMode = splitListed.length > 0
const dshomListed = bundles.includes('@mosire/dshom')

if (splitMode && dshomListed) {
  problems.push('both @mosire/dshom and the split bundles are listed in dsh.profile.bundles; pick one layout (duplicate tools otherwise)')
}
if (!splitMode && !dshomListed) {
  problems.push('no dshom bundle is listed in dsh.profile.bundles (add @mosire/dshom, or the split bundles)')
}

/** Validate one listed bundle: dependency, node_modules link and patch file. */
function checkBundle(name) {
  const short = name.split('/')[1]
  if (dependencies[name] === undefined) {
    problems.push(`${name} is listed in dsh.profile.bundles but missing from profile dependencies`)
    if (fix && name !== '@mosire/dshom') {
      const dir = join(repoRoot, 'packages', short)
      if (existsSync(dir)) {
        manifest.dependencies = { ...manifest.dependencies, [name]: `link:${dir}` }
        writeManifest(manifest)
        fixes.push(`added ${name} as a link: dependency (restart DSH)`)
      }
    }
  }
  const dir = join(profileDir, 'node_modules', '@mosire', short)
  if (!existsSync(dir)) problems.push(`bundle package is not linked at ${dir}`)
  const patch = join(dir, 'cordis.patch.yml')
  if (existsSync(dir) && !existsSync(patch)) problems.push(`bundle patch is missing: ${patch}`)
}

if (splitMode) {
  for (const name of splitListed) checkBundle(name)
  const missing = SPLIT_BUNDLES.filter((name) => !bundles.includes(name))
  if (missing.length > 0) notes.push(`split layout omits (disabled): ${missing.join(', ')}`)
} else if (dshomListed) {
  // Component layout: the umbrella must stay installed and listed, and every
  // component row in its patch must resolve from the profile's node_modules.
  if (dependencies['@mosire/dshom'] === undefined) {
    problems.push('@mosire/dshom is missing from profile dependencies (run: dsh plugin --profile ' + profile + ' add @mosire/dshom)')
  }
  checkBundle('@mosire/dshom')
  const umbrellaPatch = join(profileDir, 'node_modules', '@mosire', 'dshom', 'cordis.patch.yml')
  if (existsSync(umbrellaPatch)) {
    const text = readFileSync(umbrellaPatch, 'utf8')
    const components = [...text.matchAll(/^\s+name:\s+'([^']+)'\s*$/gmu)].map((match) => match[1])
    for (const name of new Set(components)) {
      const root = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
      const short = root.split('/')[1]
      const dir = join(profileDir, 'node_modules', '@mosire', short)
      if (!existsSync(dir)) problems.push(`dshom component package is not linked at ${dir} (row: ${name})`)
    }
    notes.push(`dshom components: ${new Set(components).size}`)
  }
}

const names = requiredPeerNames(presetRoot)
const running = runningDshAnchor()
const candidates = running === undefined ? [] : [running]
const host = findHostAnchor(candidates) ?? findHostAnchor()
if (host === undefined) {
  problems.push('cannot resolve a running DSH install; start DSH once, then rerun')
} else {
  const missing = []
  const stale = []
  const farm = join(presetRoot, 'node_modules', '@deepseek-ai')
  for (const name of names) {
    const peer = resolveHostPeer(host.anchor, name)
    if (peer === undefined) {
      missing.push(name)
      continue
    }
    const short = name.split('/')[1]
    const link = join(farm, short)
    let current
    try {
      current = realpathSync(link)
    } catch {
      current = undefined
    }
    if (current !== peer.dir) stale.push(name)
  }
  if (missing.length > 0) notes.push(`not shipped by this DSH install (optional rows disable themselves): ${missing.join(', ')}`)
  if (stale.length > 0) {
    problems.push(`stale preset peer links: ${stale.join(', ')}`)
    if (fix) {
      const result = syncPackagePeerFarm(join(presetRoot, 'lib', 'index.js'))
      if (result.synced === false) problems.push(`peer farm repair failed: ${result.error ?? 'unknown error'}`)
      else fixes.push(`refreshed ${result.changed.length} peer link(s) from ${result.anchor}`)
    }
  }
  notes.push(`running host anchor: ${host.anchor}`)
}

if (!existsSync(statusPath)) {
  notes.push(`no preset status file yet (${statusPath}); start a session after restart`)
} else {
  try {
    const status = JSON.parse(readFileSync(statusPath, 'utf8'))
    const presets = Array.isArray(status.presets) ? status.presets : []
    if (presets.length > 0) {
      const broken = presets.filter((preset) => preset.broken !== null && preset.broken !== undefined)
      if (broken.length > 0) problems.push(`last preset declarations are broken: ${broken.map((preset) => preset.id).join(', ')}`)
      else notes.push(`last preset declarations: ${presets.length} preset(s), broken null`)
    } else if (status.broken !== null && status.broken !== undefined) {
      problems.push(`last preset declaration is broken: ${status.broken}`)
    } else {
      notes.push('last preset declaration: broken null')
    }
    notes.push(`status pid: ${status.pid}`)
  } catch (error) {
    problems.push(`cannot read preset status: ${String(error?.message ?? error)}`)
  }
}

const age = statSync(manifestPath).mtime.toISOString()
console.log(`doctor: profile=${profile} manifest=${manifestPath} (mtime ${age})`)
for (const note of notes) console.log(`  note: ${note}`)
for (const problem of problems) console.log(`  PROBLEM: ${problem}`)
for (const applied of fixes) console.log(`  FIXED: ${applied}`)
if (problems.length === 0) {
  console.log('doctor: OK')
  process.exit(0)
}
if (fix) {
  const unfixable = problems.filter((problem) =>
    problem.includes('missing from profile dependencies') ||
    problem.includes('bundle package is not linked') ||
    problem.includes('cannot resolve a running DSH install') ||
    problem.includes('cannot read preset status'))
  console.log('doctor: repairs applied; restart DSH, then run doctor again to confirm broken:null')
  process.exit(unfixable.length === 0 ? 0 : 1)
}
console.log('doctor: rerun with --fix to repair the bundle entry and peer links')
process.exit(1)
