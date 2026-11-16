#!/usr/bin/env node
/**
 * verify-component-meta — assert every dshom component resolves bilingual
 * display metadata (locale `<lang>.json` → `meta.title` / `meta.description`)
 * through the same resolver the plugin manager uses.
 *
 * Usage: node tools/verify-component-meta.mjs [profile]
 * Reads the component specs from packages/dshom/cordis.patch.yml.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = dirname(here)
const profile = process.argv[2] ?? process.env.DSH_PROFILE ?? 'web'
const patch = readFileSync(join(repo, 'packages', 'dshom', 'cordis.patch.yml'), 'utf8')
const specs = [...patch.matchAll(/^\s+name:\s*'([^']+)'\s*$/gmu)].map((match) => match[1])
if (specs.length === 0) {
  console.error('verify-component-meta: no component rows found in packages/dshom/cordis.patch.yml')
  process.exit(1)
}

const shim = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
const text = readFileSync(shim, 'utf8')
const target = realpathSync(text.match(/^# cmd-shim-target=(.+)$/m)?.[1]?.trim() ?? '')
const requireFromDsh = createRequire(pathToFileURL(target))
const { readPluginMeta } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-app-boot')).href)
const parent = pathToFileURL(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profile, 'package.json')).href

const pick = (text, ...keys) => {
  if (text === undefined || text === null) return undefined
  if (typeof text === 'string') return text
  for (const key of keys) if (typeof text[key] === 'string' && text[key] !== '') return text[key]
  return undefined
}

let failures = 0
console.log(`verify-component-meta: profile=${profile} components=${specs.length}`)
for (const spec of specs) {
  const meta = readPluginMeta(spec, parent)
  const titleEn = pick(meta?.title, 'en')
  const titleZh = pick(meta?.title, 'zh', 'zh-cn', 'zh-CN')
  const descEn = pick(meta?.description, 'en')
  const descZh = pick(meta?.description, 'zh', 'zh-cn', 'zh-CN')
  const problems = []
  if (meta?.error !== undefined) problems.push(meta.error)
  if (titleEn === undefined) problems.push('title.en missing')
  if (titleZh === undefined) problems.push('title.zh missing')
  if (descEn === undefined) problems.push('description.en missing')
  if (descZh === undefined) problems.push('description.zh missing')
  if (problems.length > 0) failures += 1
  const status = problems.length === 0 ? 'OK  ' : 'FAIL'
  console.log(`  ${status} ${spec}`)
  console.log(`       ${titleZh ?? '—'} / ${titleEn ?? '—'}`)
  console.log(`       ${(descZh ?? '—').slice(0, 72)}`)
  for (const problem of problems) console.log(`       ! ${problem}`)
}
if (failures > 0) {
  console.error(`verify-component-meta: ${failures} component(s) missing display metadata`)
  process.exit(1)
}
console.log('verify-component-meta: OK')
