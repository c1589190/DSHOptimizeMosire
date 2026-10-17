#!/usr/bin/env node
/**
 * link-dsh-peers — materialize the official `@deepseek-ai/*` packages used by
 * the bundled preset composition into `<package>/node_modules/@deepseek-ai/`
 * as symlinks to the running DSH installation.
 *
 * WHY: the preset composition (`presets/liangshen/agent.cordis.yml`) is loaded
 * through `@deepseek-ai/cordis-plugin-include`, whose baseUrl is the composition
 * directory inside this workspace package. Bare package names in the
 * composition resolve through Node's node_modules walk from that directory, and
 * a workspace package has no node_modules of its own. Symlinking to the DSH
 * installation keeps module realpaths identical, so the harness and the preset
 * share one module instance of each plugin package.
 *
 * Usage: node tools/link-dsh-peers.mjs [--dsh-root <path>]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const packageRoot = join(repoRoot, 'packages', 'dsh-liangshen-anchored')
const composition = readFileSync(join(packageRoot, 'presets', 'liangshen', 'agent.cordis.yml'), 'utf8')

const names = [...new Set([...composition.matchAll(/name: '(@deepseek-ai\/[^']+)'/g)].map((match) => match[1]))]
  .map((spec) => spec.split('/').slice(0, 2).join('/')) // scoped package root, subpaths dropped
  .sort()

const argIndex = process.argv.indexOf('--dsh-root')
let dshRoot = argIndex >= 0 ? process.argv[argIndex + 1] : undefined
if (dshRoot === undefined) {
  const require = createRequire(import.meta.url)
  dshRoot = dirname(require.resolve('@deepseek-ai/dsh/package.json', { paths: [process.cwd(), '/usr/local/lib/node_modules', '/home/cna/.npm-global/lib/node_modules'] }))
}
const sourceRoot = join(dshRoot, 'node_modules', '@deepseek-ai')
const targetRoot = join(packageRoot, 'node_modules', '@deepseek-ai')

mkdirSync(targetRoot, { recursive: true })
const missing = []
for (const name of names) {
  const packageName = name.split('/')[1]
  const source = join(sourceRoot, packageName)
  const target = join(targetRoot, packageName)
  if (!existsSync(source)) { missing.push(name); continue }
  rmSync(target, { recursive: true, force: true })
  symlinkSync(source, target, 'dir')
}
console.log(JSON.stringify({ dshRoot, linked: names.length - missing.length, missing, targetRoot }, null, 2))
