// ─────────────────────────────────────────────────────────────────────────────
// filterUtils.js — helpers for SELECTIVE migrations (master data + key figures).
//
// buildConditionFilter turns UI conditions into an OData $filter fragment; the
// operators were verified live against MASTER_DATA_API_SRV / PLANNING_DATA_API_SRV
// (eq, or-chains and startswith() are all honoured by the tenant).
// ─────────────────────────────────────────────────────────────────────────────

// Splits a comma-separated value string into clean tokens.
export function splitValues(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean)
}

// Builds an OData $filter fragment from UI conditions:
//   [{ field, op: 'in'|'sw', value: 'A' | 'A,B,C' }]
//     → "(FIELD eq 'A' or FIELD eq 'B') and startswith(FIELD2,'X')"
// 'in' with one value collapses to a plain eq; conditions AND together.
// Returns '' when no condition is complete.
export function buildConditionFilter(conds) {
  const esc = v => String(v).replace(/'/g, "''")   // OData: single quote → doubled
  const parts = []
  for (const c of (conds || [])) {
    const vals = splitValues(c.value)
    if (!c.field || vals.length === 0) continue
    if (c.op === 'sw') parts.push(`startswith(${c.field},'${esc(vals[0])}')`)
    else if (vals.length === 1) parts.push(`${c.field} eq '${esc(vals[0])}'`)
    else parts.push('(' + vals.map(v => `${c.field} eq '${esc(v)}'`).join(' or ') + ')')
  }
  return parts.join(' and ')
}

// Compact human chip for an active condition (shown next to the table/section).
export function condChip(c) {
  const vals = splitValues(c.value)
  if (!c.field || vals.length === 0) return null
  if (c.op === 'sw') return `${c.field} ⌐ ${vals[0]}…`
  if (vals.length === 1) return `${c.field} = ${vals[0]}`
  if (vals.length <= 3) return `${c.field} ∈ [${vals.join(', ')}]`
  return `${c.field} ∈ [${vals.slice(0, 3).join(', ')} +${vals.length - 3}]`
}
