// ─────────────────────────────────────────────────────────────────────────────
// csv.js — build + download CSV for the data viewers (Ver DM / Ver DT).
//
// Excel-ES friendly by design: ';' delimiter + a UTF-8 BOM so Excel (locale
// español) opens the file straight into columns and shows tildes/ñ correctly.
// Cell values reuse the grid's formatCell, so the CSV matches EXACTLY what the
// user sees on screen (WYSIWYG): OData dates become locale strings, numbers/text
// pass through verbatim (decimals keep their on-screen form, e.g. "1250.5").
// Quoting follows RFC-4180: a field is wrapped in double quotes (and its own
// quotes doubled) only when it contains the delimiter, a quote, CR or LF.
// ─────────────────────────────────────────────────────────────────────────────
import { formatCell } from '../services/catalogHelpers'

const DELIM = ';'

function csvCell(val) {
  const c = formatCell(val)
  const s = c == null ? '' : String(c)
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// CSV text (header row + one line per row) for the given ordered columns.
export function rowsToCsv(columns, rows) {
  const lines = [columns.map(csvCell).join(DELIM)]
  for (const r of rows) lines.push(columns.map(c => csvCell(r[c])).join(DELIM))
  return lines.join('\r\n')
}

// Trigger a browser download of `text` as a UTF-8 .csv file. The string is prefixed
// with a U+FEFF byte-order mark so Excel reads it as UTF-8 (tildes/ñ render correctly).
export function downloadCsv(filename, text) {
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)   // revoke once the download has started
}
