#!/usr/bin/env node
/**
 * doctor — check (and optionally repair) the machine-local install of dshom.
 *
 * DSH upgrades rewrite the global install directory, and profile package
 * operations can drop a bundle entry from `dsh.profile.bundles`. Neither is a
 * property of our source tree, so this script verifies the three machine-local
 * couplings and repairs the two that are safe to rewrite:
 *
 *   1. `@mosire/dshom` is a profile dependency and is listed in
 *      `dsh.profile.bundles` (otherwise the Host half never mounts);
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

if (dependencies['@mosire/dshom'] === undefined) {
  problems.push('@mosire/dshom is missing from profile dependencies (run: dsh plugin --profile ' + profile + ' add @mosire/dshom)')
} else if (!bundles.includes('@mosire/dshom')) {
  problems.push('@mosire/dshom is installed but not listed in dsh.profile.bundles')
  if (fix) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, '@mosire/dshom'] } }
    writeManifest(manifest)
    fixes.push('added @mosire/dshom to dsh.profile.bundles (restart DSH)')
  }
}

const bundleDir = join(profileDir, 'node_modules', '@mosire', 'dshom')
if (!existsSync(bundleDir)) problems.push(`bundle package is not linked at ${bundleDir}`)
const patchPath = join(bundleDir, 'cordis.patch.yml')
if (existsSync(bundleDir) && !existsSync(patchPath)) problems.push(`bundle patch is missing: ${patchPath}`)

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
    if (status.broken !== null && status.broken !== undefined) problems.push(`last preset declaration is broken: ${status.broken}`)
    else notes.push('last preset declaration: broken null')
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
