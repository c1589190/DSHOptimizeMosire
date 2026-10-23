import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  findHostAnchor,
  hostAnchorCandidates,
  packageDirFromAnchor,
  requiredPeerNames,
  resolveHostPeer,
  syncPackagePeerFarm,
  syncPeerFarm,
} from '../lib/host-peers.js'

/** Create one fake package with a package.json below a host root. */
function fakePackage(root, name, version = '0.2.1-rc.2') {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'lib/index.js' }))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'index.js'), 'export default function plugin() {}\n')
  return dir
}

/** Create a fake host install whose CLI entry is `<root>/node_modules/@deepseek-ai/dsh/lib/bin.js`. */
function fakeHost(root, packages = ['dsh', 'dsh-persona', 'dsh-tool-bash']) {
  for (const name of packages) fakePackage(root, `@deepseek-ai/${name}`)
  const bin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  writeFileSync(bin, '#!/usr/bin/env node\n')
  return bin
}

test('packageDirFromAnchor probes require paths instead of requiring a package.json export', () => {
  const root = mkdtempSync(join(tmpdir(), 'dshom-peers-'))
  try {
    const bin = fakeHost(root)
    const dir = packageDirFromAnchor(bin, '@deepseek-ai/dsh-persona')
    assert.equal(dir, join(root, 'node_modules', '@deepseek-ai', 'dsh-persona'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('findHostAnchor skips a candidate that resolves nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'dshom-peers-'))
  try {
    const hostRoot = join(root, 'host')
    const bin = fakeHost(hostRoot)
    const missing = join(root, 'gone', 'lib', 'bin.js')
    assert.equal(findHostAnchor([missing, bin])?.anchor, bin)
    assert.equal(findHostAnchor([missing])?.anchor, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('syncPeerFarm creates links to the current install and prunes stale entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'dshom-peers-'))
  const packageRoot = join(root, 'preset-package')
  try {
    mkdirSync(packageRoot, { recursive: true })
    const hostA = join(root, 'host-a')
    const binA = fakeHost(hostA)
    const resultA = syncPeerFarm({ packageRoot, anchor: binA, names: ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-bash'] })
    assert.equal(resultA.synced, true)
    assert.deepEqual(resultA.missing, [])
    const farm = join(packageRoot, 'node_modules', '@deepseek-ai')
    const personaLink = join(farm, 'dsh-persona')
    assert.equal(readlinkSync(personaLink), join(hostA, 'node_modules', '@deepseek-ai', 'dsh-persona'))
    assert.equal(existsSync(join(personaLink, 'package.json')), true)

    // An obsolete entry from an older install is removed, not left dangling.
    symlinkSync(join(hostA, 'node_modules', '@deepseek-ai', 'dsh-persona'), join(farm, 'obsolete'), 'dir')
    const hostB = join(root, 'host-b')
    const binB = fakeHost(hostB)
    const resultB = syncPeerFarm({ packageRoot, anchor: binB, names: ['@deepseek-ai/dsh-persona'] })
    assert.equal(resultB.synced, true)
    assert.equal(readlinkSync(personaLink), join(hostB, 'node_modules', '@deepseek-ai', 'dsh-persona'))
    assert.equal(existsSync(join(farm, 'obsolete')), false)
    assert.deepEqual(resultB.missing, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('syncPeerFarm without a host anchor leaves an existing farm untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'dshom-peers-'))
  const packageRoot = join(root, 'preset-package')
  try {
    const farm = join(packageRoot, 'node_modules', '@deepseek-ai')
    mkdirSync(farm, { recursive: true })
    const target = join(root, 'keep-me')
    mkdirSync(target)
    symlinkSync(target, join(farm, 'dsh-persona'), 'dir')
    const result = syncPeerFarm({ packageRoot, anchor: undefined, names: ['@deepseek-ai/dsh-persona'] })
    assert.equal(result.synced, false)
    assert.equal(readlinkSync(join(farm, 'dsh-persona')), target)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('requiredPeerNames reads composition rows (including subpaths) and Host imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'dshom-peers-'))
  try {
    const presetDir = join(root, 'presets', 'liangshen')
    mkdirSync(presetDir, { recursive: true })
    writeFileSync(join(presetDir, 'agent.cordis.yml'), [
      "- id: persona",
      "  name: '@deepseek-ai/dsh-persona'",
      '- id: list',
      '  name: "@deepseek-ai/dsh-tool-subagent-control/list-agents"',
      '- id: group',
      '  group: true',
      '  config:',
      "    - name: '@deepseek-ai/dsh-tool-bash'",
    ].join('\n'))
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'lib', 'index.js'), "import value from '@deepseek-ai/dsh-tool-fs'\n")
    assert.deepEqual(requiredPeerNames(root), [
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-tool-bash',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-subagent-control',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hostAnchorCandidates prefers an explicit anchor and realpaths argv[1]', () => {
  const root = mkdtempSync(join(tmpdir(), 'dshom-peers-'))
  try {
    const bin = fakeHost(root)
    const link = join(root, 'dsh-bin.js')
    symlinkSync(bin, link)
    const candidates = hostAnchorCandidates({ DSH_INSTALL_ANCHOR: '/explicit/bin.js' }, ['node', link])
    assert.equal(candidates[0], '/explicit/bin.js')
    assert.ok(candidates.includes(link))
    assert.ok(candidates.includes(bin))
    assert.equal(resolveHostPeer(bin, '@deepseek-ai/dsh-persona')?.dir, join(root, 'node_modules', '@deepseek-ai', 'dsh-persona'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('syncPackagePeerFarm resolves a package root from a plain index.js path', () => {
  const root = mkdtempSync(join(tmpdir(), 'dshom-peers-'))
  const packageRoot = join(root, 'preset-package')
  try {
    const bin = fakeHost(join(root, 'host'))
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(packageRoot, 'lib', 'index.js'), "import '@deepseek-ai/dsh-persona'\n")
    const result = syncPackagePeerFarm(join(packageRoot, 'lib', 'index.js'), {
      argv: ['node', bin],
      env: {},
    })
    assert.equal(result.synced, true)
    assert.equal(readlinkSync(join(packageRoot, 'node_modules', '@deepseek-ai', 'dsh-persona')), join(root, 'host', 'node_modules', '@deepseek-ai', 'dsh-persona'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
