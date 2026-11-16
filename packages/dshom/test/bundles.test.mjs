import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { apply as applyJobTools } from '../../dsh-job-tools/lib/index.js'
import { apply as applySessionImport } from '../../dsh-session-import/lib/index.js'
import { apply as applyPromptLabSession } from '../../dsh-prompt-lab-session/lib/index.js'
import { apply as applySessionInspect } from '../../dsh-session-inspect/lib/index.js'
import { apply as applyGoalConfirm } from '../../dsh-goal-confirm/lib/index.js'
import { apply as applySubagentAccess } from '../../dsh-subagent-access/lib/index.js'
import { apply as applyLiangshen } from '../../dsh-liangshen-anchored/lib/index.js'

/** Every package that must be installable as its own bundle row. */
const BUNDLES = [
  ['@mosire/dsh-goal-confirm', 'dsh-goal-confirm', applyGoalConfirm],
  ['@mosire/dsh-subagent-access', 'dsh-subagent-access', applySubagentAccess],
  ['@mosire/dsh-job-tools', 'dsh-job-tools', applyJobTools],
  ['@mosire/dsh-session-import', 'dsh-session-import', applySessionImport],
  ['@mosire/dsh-prompt-lab-session', 'dsh-prompt-lab-session', applyPromptLabSession],
  ['@mosire/dsh-session-inspect', 'dsh-session-inspect', applySessionInspect],
  ['@mosire/dsh-liangshen-anchored', 'dsh-liangshen-anchored', applyLiangshen],
]

const root = (dir) => new URL(`../../${dir}/`, import.meta.url)

for (const [name, dir, apply] of BUNDLES) {
  test(`${name} is a standalone bundle`, () => {
    const manifestPath = new URL('package.json', root(dir))
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(manifest.name, name)
    assert.equal(typeof apply, 'function', 'the package root must export apply()')

    const patch = manifest.dsh?.bundle?.patch
    assert.ok(patch !== undefined, 'dsh.bundle.patch is required for an independent install')
    const patches = Array.isArray(patch) ? patch : [patch]
    assert.ok(patches.length > 0)
    for (const relative of patches) {
      const file = new URL(relative, root(dir))
      assert.ok(existsSync(file), `missing bundle patch: ${fileURLToPath(file)}`)
      const text = readFileSync(file, 'utf8')
      assert.match(text, /^- insert:/mu, 'a bundle patch must insert a row')
      assert.ok(text.includes(`name: '${name}'`), `bundle patch must mount ${name}`)
    }

    assert.ok(manifest.exports?.['./package.json'], 'export ./package.json for diagnostics')
    assert.ok(manifest.files?.includes('cordis.patch.yml') || Array.isArray(patch), 'ship the patch file')
  })
}

test('@mosire/dshom remains the only all-in-one entry', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})


test('@mosire/dshom mounts nine independently switchable components', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const names = [
    '@mosire/dsh-liangshen-anchored/presets/liangshen',
    '@mosire/dsh-liangshen-anchored/presets/empty-system',
    '@mosire/dsh-liangshen-anchored/presets/prompt-lab',
    '@mosire/dsh-goal-confirm',
    '@mosire/dsh-subagent-access',
    '@mosire/dsh-job-tools',
    '@mosire/dsh-session-import',
    '@mosire/dsh-prompt-lab-session',
    '@mosire/dsh-session-inspect',
  ]
  for (const name of names) assert.ok(patch.includes(`name: '${name}'`), name)
  assert.equal((patch.match(/^    - id:/gmu) ?? []).length, 9)
})
