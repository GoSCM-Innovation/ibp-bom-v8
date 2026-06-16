// ─────────────────────────────────────────────────────────────────────────────
// catalogHelpers.js — pure helpers shared by the Migration tab and the Data Viewer.
//
// getPas / getVersions / getMdts operate on the structured catalog returned by
// buildCatalog() (masterDataApi.js): { [paId]: { desc, versions: [{ id, name, mdts }] } }.
// formatCell turns OData v2 date strings into a readable value for display.
// ─────────────────────────────────────────────────────────────────────────────

// Planning areas as [{ id, desc }], sorted by id.
export function getPas(catalog) {
  if (!catalog) return []
  return Object.entries(catalog)
    .map(([id, { desc }]) => ({ id, desc }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

// Versions of a planning area: [{ id, name }].
export function getVersions(catalog, pa) {
  if (!catalog || !pa) return []
  return catalog[pa]?.versions || []
}

// MDTs available for a PA + version. When version is '' (base) → return the
// union of all MDTs across that PA's versions.
export function getMdts(catalog, pa, version) {
  if (!catalog || !pa) return []
  const paEntry = catalog[pa]
  if (!paEntry) return []
  if (!version) {
    const all = new Set()
    paEntry.versions.forEach(v => v.mdts.forEach(m => all.add(m)))
    return [...all].sort()
  }
  const vEntry = paEntry.versions.find(v => v.id === version)
  return vEntry ? [...vEntry.mdts].sort() : []
}

// Converts OData v2 date strings like /Date(1764247462000+0000)/ to locale format.
export function formatCell(val) {
  if (typeof val !== 'string') return val ?? ''
  const m = val.match(/^\/Date\((\d+)([+-]\d{4})?\)\/$/)
  if (m) return new Date(parseInt(m[1], 10)).toLocaleString()
  return val
}
