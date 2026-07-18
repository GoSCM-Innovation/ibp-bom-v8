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

// OData v2 date strings come back as "/Date(1753734272000+0000)/". They CANNOT be
// compared as quoted strings (SAP: "Invalid parametertype used at function 'eq'") —
// a date field needs a date literal. We emit a datetimeoffset literal because the
// tenant returns the value with an explicit +0000 offset.
const ODATA_DATE_RE = /^\/Date\((\d+)([+-]\d{4})?\)\/$/

// Returns the OData literal for a value: a datetimeoffset literal for /Date(...)/
// values, otherwise a normal quoted string (single quotes doubled).
function odataLiteral(val) {
  const s = String(val)
  const m = s.match(ODATA_DATE_RE)
  if (m) {
    // epoch ms → ISO UTC, dropping milliseconds: datetimeoffset'2026-07-28T20:51:12Z'
    const iso = new Date(parseInt(m[1], 10)).toISOString().replace(/\.\d{3}Z$/, 'Z')
    return `datetimeoffset'${iso}'`
  }
  return `'${s.replace(/'/g, "''")}'`
}

// Builds an OData $filter fragment from UI conditions:
//   [{ field, op: 'in'|'sw'|'nb', value: 'A' | 'A,B,C' | (ignored for 'nb') }]
//     → "(FIELD eq 'A' or FIELD eq 'B') and startswith(FIELD2,'X') and FIELD3 gt ''"
// Only INCLUSION operators: 'in' (or-chain of eq), 'sw' (startswith) and 'nb'
// (not blank). These are transparent — you migrate exactly what they name.
// Exclusion ('ne') was removed on purpose: verified live that any predicate on a
// field also DROPS rows whose field is EMPTY (BRAND ne 'X' = 3138, not 8005; the
// ~4.9k blank-brand rows vanish and no syntax recovers them — eq null / eq '' both
// match 0). "Exclude X" therefore silently lost the blanks. To exclude, the user
// selects every OTHER value from the real-values dropdown — explicit, no surprise.
// 'nb' leverages that same behaviour ON PURPOSE: FIELD gt '' keeps only rows whose
// field holds a non-empty value (NULL and '' both fail the comparison). Verified
// live against PLANNING_DATA_API_SRV (CTYTTS): gt '' → 223.554 of 447.845 (exactly
// the non-blank groups). Do NOT use ne '' — SAP IGNORES it silently (returns the
// full count); ne null and startswith(F,'') are rejected with 400.
// Conditions AND together. Returns '' when no condition is complete.
export function buildConditionFilter(conds) {
  const esc = v => String(v).replace(/'/g, "''")   // OData: single quote → doubled
  const parts = []
  for (const c of (conds || [])) {
    if (!c.field) continue
    if (c.op === 'nb') { parts.push(`${c.field} gt ''`); continue }   // takes no value
    const vals = splitValues(c.value)
    if (vals.length === 0) continue
    // startswith() is a string function — it only applies to text fields, so keep
    // the raw quoted form here (a date value wouldn't make sense with 'sw' anyway).
    if (c.op === 'sw') parts.push(`startswith(${c.field},'${esc(vals[0])}')`)
    else if (vals.length === 1) parts.push(`${c.field} eq ${odataLiteral(vals[0])}`)
    else parts.push('(' + vals.map(v => `${c.field} eq ${odataLiteral(v)}`).join(' or ') + ')')
  }
  return parts.join(' and ')
}

// Human-readable label for a single value: OData date strings become locale dates,
// everything else is shown as-is.
export function displayValue(val) {
  const m = String(val).match(ODATA_DATE_RE)
  return m ? new Date(parseInt(m[1], 10)).toLocaleString() : String(val)
}

// Compact human chip for an active condition (shown next to the table/section).
export function condChip(c) {
  if (!c.field) return null
  if (c.op === 'nb') return `${c.field} ≠ ∅`
  const vals = splitValues(c.value).map(displayValue)
  if (vals.length === 0) return null
  if (c.op === 'sw') return `${c.field} ⌐ ${vals[0]}…`
  if (vals.length === 1) return `${c.field} = ${vals[0]}`
  if (vals.length <= 3)  return `${c.field} ∈ [${vals.join(', ')}]`
  return `${c.field} ∈ [${vals.slice(0, 3).join(', ')} +${vals.length - 3}]`
}
