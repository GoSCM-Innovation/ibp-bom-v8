// ─────────────────────────────────────────────────────────────────────────────
// tabsHelpers.js — shared helpers for the multi-tab data viewers (Ver DM / Ver DT).
//
// Each viewer can hold several open tabs at once. Tabs are auto-organised by
// Área → Versión → hoja (tabla maestra / nivel de KF) and get a stable colour
// accent per área so the groups read at a glance. We persist only the tab
// DEFINITIONS (selección, no las filas) per connection — data is re-fetched on
// demand ("Mostrar datos"), never on restore, to keep egress bounded.
// ─────────────────────────────────────────────────────────────────────────────

// Soft cap on simultaneously open tabs per viewer (bounds memory: each tab keeps
// its loaded page in memory; only the active one renders its grid into the DOM).
export const TAB_LIMIT = 8

const STORAGE_KEY = (kind, connId) => `ibp:viewer:tabs:${kind}:${connId}`

// A tab: { id, def, meta }
//   def  — opaque restore payload owned by the inner viewer (área/versión/tabla or
//          level). Used to hydrate the tab on restore; ViewerTabs never reads it.
//   meta — { areaId, versionId, leafLabel } used here for the label, sort and colour.

export function loadTabs(kind, connId) {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY(kind, connId)))
    if (raw && Array.isArray(raw.tabs) && raw.tabs.length) return raw
  } catch { /* ignore corrupt/absent */ }
  return null
}

export function saveTabs(kind, connId, state) {
  try { localStorage.setItem(STORAGE_KEY(kind, connId), JSON.stringify(state)) } catch { /* quota */ }
}

// Stable hue from an área id → an accent colour. Deterministic, works for any number
// of áreas (no fixed palette to run out of). FNV-1a for a well-mixed pseudo-index,
// then a golden-angle step so even near-identical ids (AREA1/AREA2) land on distant
// hues instead of nearly the same colour. Tuned S/L read on both light/dark themes.
export function areaColor(areaId) {
  if (!areaId) return 'var(--border2)'
  let h = 2166136261
  for (let i = 0; i < areaId.length; i++) { h ^= areaId.charCodeAt(i); h = Math.imul(h, 16777619) }
  const hue = Math.round(((h >>> 0) % 360) * 137.508) % 360
  return `hsl(${hue} 58% 55%)`
}

// Sort by área, then versión, then hoja. Tabs with no área yet (new/empty, still
// being configured) sort LAST in their original insertion order so they don't jump
// around mid-setup.
export function sortTabs(tabs) {
  return tabs
    .map((tab, i) => [tab, i])
    .sort(([a, ai], [b, bi]) => {
      const am = a.meta || {}, bm = b.meta || {}
      if (!am.areaId && !bm.areaId) return ai - bi
      if (!am.areaId) return 1
      if (!bm.areaId) return -1
      return String(am.areaId).localeCompare(String(bm.areaId))
        || String(am.versionId || '').localeCompare(String(bm.versionId || ''))
        || String(am.leafLabel || '').localeCompare(String(bm.leafLabel || ''))
        || (ai - bi)
    })
    .map(([tab]) => tab)
}

// Full tab label "ÁREA · VERSIÓN · hoja" — used for the hover tooltip (title), where
// the complete context is welcome. Falls back to "Nueva pestaña" while no área yet.
export function tabLabel(meta, t) {
  if (!meta || !meta.areaId) return t('viewer.tabUntitled')
  return [meta.areaId, meta.versionId || t('viewer.tabBase'), meta.leafLabel]
    .filter(Boolean)
    .join(' · ')
}

// Compact two-line label for the tab strip:
//   primary   — la hoja (tabla maestra / "N KF"); cae al área mientras no se elige
//               tabla/nivel, o "Nueva pestaña" para una pestaña vacía.
//   secondary — la versión (o "base"); vacío para una pestaña sin título.
// El área se transmite por el color de acento + el separador de grupo + el tooltip
// completo (tabLabel), así que se omite a propósito del texto de cada pestaña para
// que la etiqueta sea minimalista y no ocupe ancho repitiendo el área en cada una.
export function tabLabelParts(meta, t) {
  if (!meta || !meta.areaId) return { primary: t('viewer.tabUntitled'), secondary: '' }
  return { primary: meta.leafLabel || meta.areaId, secondary: meta.versionId || t('viewer.tabBase') }
}
