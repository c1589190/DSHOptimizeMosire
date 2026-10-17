/**
 * Host half of the anchored LiangShen bundle.
 *
 * M0 finding: a bundle patch cannot declare the preset *composition* directly.
 * A static `config.plugins` entry pointing at `@deepseek-ai/cordis-plugin-include`
 * resolves a relative `config.path` against the PROFILE directory
 * (`$DSH_HOME/profiles/<name>/`), not against the installed bundle, and a
 * top-level `config: !!js` expression is passed to the declaration as an inert
 * marker. The working route — the same one dsh-TUI and dsh-web use — is to
 * declare the preset at activation from this Host plugin, handing the registry
 * an absolute `file://` URL for the bundled composition. The include plugin then
 * sets its own baseUrl to the composition's directory, so the relative
 * `./*.mjs` plugin names inside `agent.cordis.yml` resolve inside the package.
 *
 * This bundle declares TWO presets from the same preset directory:
 *
 *   - `liangshen` — the anchored LiangShen preset (order 5);
 *   - `liangshen-empty-system` — the same composition with the persona prefix
 *     replaced by a single ASCII space (order 6), for system-prompt-free
 *     comparison runs. Its composition is generated from the main one by
 *     `tools/sync-preset-variant.mjs`; the test suite fails when it is stale.
 *
 * Declare = enabled: the registry mounts each preset's rows eagerly and returns
 * a disposer this plugin owns through `ctx.effect`, so unloading the row
 * unmounts the preset and nothing is written into the harness home.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Stable cordis plugin name (loader diagnostics). */
export const name = 'liangshen-anchored'

/** The bundled preset directory, resolved from this module rather than the profile. */
const PRESET_ROOT = new URL('../presets/liangshen/', import.meta.url)

/**
 * One declaration per bundled preset. `composition` and `metadata` are relative
 * to {@link PRESET_ROOT}; `fallback` metadata is used if the YAML file is
 * missing (it is part of the package, so this is diagnostic robustness only).
 */
const PRESETS = [
  {
    id: 'liangshen',
    metadata: 'preset.yml',
    composition: 'agent.cordis.yml',
    fallback: {
      name: '梁神模式',
      description: '主 Agent 与子 Agent 首轮均保持极简模式的最小工具面，首次工具调用后开放完整目录，压缩后重新锚定。',
      order: 5,
    },
  },
  {
    id: 'liangshen-empty-system',
    metadata: 'preset.empty-system.yml',
    composition: 'agent.empty-system.cordis.yml',
    fallback: {
      name: '梁神模式·空系统提示词',
      description: '与梁神模式（锚定式）完全一致，唯一差异是系统提示词被替换为单个空格。',
      order: 6,
    },
  },
]

/** Minimal preset.yml reader: `name`, `description`, `order` are plain scalars. */
async function readMetadata(spec) {
  try {
    const text = await readFile(new URL(spec.metadata, PRESET_ROOT), 'utf8')
    const metadata = { ...spec.fallback }
    for (const line of text.split('\n')) {
      const match = /^(name|description|order):\s*(.+)$/u.exec(line.trim())
      if (match === null) continue
      const [, key, raw] = match
      metadata[key] = key === 'order' ? Number(raw) : raw
    }
    return metadata
  } catch {
    return { ...spec.fallback }
  }
}

/** Best-effort local diagnostic: the last declaration outcome, readable by tools. */
async function writeStatus(entry) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const path = join(home, 'liangshen-anchored-status.json')
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ pid: process.pid, ...entry }, null, 2)}\n`, 'utf8')
  } catch {
    // Diagnostics must never break activation.
  }
}

/**
 * Declare one bundled preset through the live agent-presets registry.
 * @returns {Promise<{id: string, declared: boolean, composition: string, broken?: string|null, error?: string}>}
 */
async function declareOne(ctx, registry, spec) {
  const composition = new URL(spec.composition, PRESET_ROOT).href
  try {
    const metadata = await readMetadata(spec)
    const dispose = await registry.register({
      id: spec.id,
      name: metadata.name,
      description: metadata.description,
      order: metadata.order,
      plugins: [
        {
          id: `${spec.id}-plugins`,
          name: '@deepseek-ai/cordis-plugin-include',
          config: { path: composition },
        },
      ],
    })
    ctx.effect(() => dispose)
    let broken = null
    try {
      const roster = await registry.list()
      broken = roster.find((preset) => preset.id === spec.id)?.broken ?? null
    } catch {
      // Roster read is diagnostic only.
    }
    if (broken !== null) {
      ctx.logger?.warn?.('liangshen-anchored: preset "%s" declared but its activation is broken: %s', spec.id, broken)
    }
    return { id: spec.id, declared: true, composition, broken }
  } catch (error) {
    const message = String(error?.message ?? error)
    ctx.logger?.error?.('liangshen-anchored: preset "%s" declaration failed: %s', spec.id, message)
    return { id: spec.id, declared: false, composition, error: message }
  }
}

/** Declare every bundled preset; one failure must not block the other. */
export async function declarePresets(ctx) {
  const registry = ctx.get('agentPresets')
  if (registry === undefined || typeof registry.register !== 'function') {
    await writeStatus({ declared: false, error: 'agentPresets service unavailable', presets: [] })
    return
  }
  const presets = []
  for (const spec of PRESETS) presets.push(await declareOne(ctx, registry, spec))
  const base = presets.find((preset) => preset.id === 'liangshen')
  await writeStatus({
    declared: presets.every((preset) => preset.declared),
    presets,
    // Backward-compatible single-preset projection: the diagnostics file is
    // read by hand and by older notes, so keep the original keys meaningful.
    ...(base === undefined ? {} : {
      presetId: 'liangshen',
      composition: base.composition,
      broken: base.declared ? base.broken ?? null : null,
      ...(base.error === undefined ? {} : { error: base.error }),
    }),
  })
}

export function apply(ctx) {
  if (ctx.get('agentPresets') !== undefined) {
    void declarePresets(ctx)
    return
  }
  ctx.inject(['agentPresets'], async (ready) => {
    await declarePresets(ready)
  })
}
