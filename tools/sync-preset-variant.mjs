#!/usr/bin/env node
/**
 * sync-preset-variant — derive the empty-system composition from the main
 * anchored LiangShen composition.
 *
 * The `liangshen-empty-system` preset is the anchored preset with exactly one
 * semantic difference: the system prompt (persona prefix) is a single ASCII
 * space. Keeping a 458-line copy in sync by hand would drift, so the variant
 * file `presets/liangshen/agent.empty-system.cordis.yml` is generated from
 * `presets/liangshen/agent.cordis.yml` by this script; the test suite
 * (`packages/dsh-liangshen-anchored/test/composition.test.mjs`) compares the
 * committed file with `renderEmptySystemComposition()` and fails on staleness.
 *
 * The variant lives in the same directory as the base composition so the
 * composition's relative `./*.mjs` plugin names keep resolving.
 *
 * Usage:
 *   node tools/sync-preset-variant.mjs           # verify: exit 1 when stale
 *   node tools/sync-preset-variant.mjs --write   # regenerate the committed file
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)

/** The bundled preset directory shared by both presets. */
export const presetDir = join(repoRoot, 'packages', 'dsh-liangshen-anchored', 'presets', 'liangshen')
/** The authoritative composition. */
export const BASE_FILE = join(presetDir, 'agent.cordis.yml')
/** The generated empty-system composition. */
export const VARIANT_FILE = join(presetDir, 'agent.empty-system.cordis.yml')

/** The persona literal to replace — keep byte-identical to the base composition. */
export const PERSONA_LITERAL = "const persona = 'You are a helpful software engineer assistant.'"
/** The persona literal of the empty-system variant (exactly one ASCII space). */
export const EMPTY_PERSONA_LITERAL = "const persona = ' '"

const SOURCE_COMMENT = '# Keep this text byte-identical to the Minimal preset. `complete` prevents the'
const VARIANT_COMMENT = [
  '# EMPTY-SYSTEM VARIANT (generated): the persona is a single ASCII space; everything',
  '# else is identical to agent.cordis.yml. `complete` prevents the',
].join('\n')

/** Header prepended to the generated variant so nobody edits it by hand. */
export const VARIANT_HEADER = [
  '# GENERATED FILE — do not edit by hand. Regenerate with:',
  '#   node tools/sync-preset-variant.mjs --write',
  '# Derived from agent.cordis.yml; the only intended difference is the system',
  '# prompt (a single ASCII space, see the persona row below).',
  '',
].join('\n')

/**
 * Render the empty-system composition from the base composition text.
 * @param {string} baseText - contents of agent.cordis.yml.
 * @returns {string} contents of agent.empty-system.cordis.yml.
 */
export function renderEmptySystemComposition(baseText) {
  if (!baseText.includes(PERSONA_LITERAL)) {
    throw new Error(`sync-preset-variant: persona literal not found in ${BASE_FILE}; update PERSONA_LITERAL`)
  }
  if (!baseText.includes(SOURCE_COMMENT)) {
    throw new Error(`sync-preset-variant: persona comment not found in ${BASE_FILE}; update SOURCE_COMMENT`)
  }
  const variant = baseText
    .replace(PERSONA_LITERAL, EMPTY_PERSONA_LITERAL)
    .replace(SOURCE_COMMENT, VARIANT_COMMENT)
  return `${VARIANT_HEADER}${variant}`
}

function main(argv) {
  const baseText = readFileSync(BASE_FILE, 'utf8')
  const expected = renderEmptySystemComposition(baseText)
  const write = argv.includes('--write')
  if (write) {
    writeFileSync(VARIANT_FILE, expected, 'utf8')
    console.log(`sync-preset-variant: wrote ${VARIANT_FILE}`)
    return
  }
  let actual
  try {
    actual = readFileSync(VARIANT_FILE, 'utf8')
  } catch {
    console.error(`sync-preset-variant: ${VARIANT_FILE} is missing; run with --write`)
    process.exitCode = 1
    return
  }
  if (actual === expected) {
    console.log(`sync-preset-variant: ${VARIANT_FILE} is in sync`)
    return
  }
  console.error(`sync-preset-variant: ${VARIANT_FILE} is stale; run with --write`)
  process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv)
