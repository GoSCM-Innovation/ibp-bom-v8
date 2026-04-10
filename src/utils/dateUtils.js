/**
 * dateUtils.js
 * Centraliza todo el manejo de fechas/horas.
 *
 * Regla de oro:
 *  - SAP IBP devuelve timestamps en UTC (confirmado).
 *  - Internamente siempre operamos en UTC.
 *  - El display puede ser UTC o local según preferencia del usuario (toggle).
 *  - Los filtros datetime-local se interpretan en la zona elegida y se
 *    convierten a UTC antes de enviarse a SAP.
 */

// ─── Preferencia de zona horaria ─────────────────────────────────────────────
const TZ_KEY = 'ibp_tz_mode' // 'utc' | 'local'

export function getTzMode() {
  return localStorage.getItem(TZ_KEY) || 'utc'
}

export function setTzMode(mode) {
  localStorage.setItem(TZ_KEY, mode)
}

/** Devuelve el offset del navegador como string, ej. "UTC-3" o "UTC+5:30" */
export function getTzLabel() {
  const off = -new Date().getTimezoneOffset() // minutos positivos = adelantado
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, '0')}`
}

// ─── Conversión de Date → formato SAP (siempre UTC) ──────────────────────────
/**
 * Convierte un objeto Date al formato SAP "YYYYMMDDHHMMSS.0000000".
 * Usa métodos UTC para que el valor enviado a SAP sea siempre UTC.
 */
export function toSapTs(date) {
  const p = n => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}` +
    `${p(date.getUTCMonth() + 1)}` +
    `${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}` +
    `${p(date.getUTCMinutes())}` +
    `${p(date.getUTCSeconds())}` +
    `.0000000`
  )
}

// ─── Parseo de timestamp SAP → Date (interpreta como UTC) ────────────────────
/**
 * Parsea "YYYYMMDDHHMMSS.0000000" como UTC y devuelve un Date.
 * Retorna null si el string es inválido.
 */
export function parseSapTs(ts) {
  if (!ts || ts.length < 8) return null
  return new Date(Date.UTC(
    parseInt(ts.slice(0, 4)),
    parseInt(ts.slice(4, 6)) - 1,
    parseInt(ts.slice(6, 8)),
    parseInt(ts.slice(8, 10) || 0),
    parseInt(ts.slice(10, 12) || 0),
    parseInt(ts.slice(12, 14) || 0),
  ))
}

// ─── Formato para display ─────────────────────────────────────────────────────
/**
 * Formatea un timestamp SAP para mostrar al usuario.
 * - mode='utc'  → "09/04/2026 14:30:45 UTC"
 * - mode='local' → "09/04/2026 11:30:45 (UTC-3)"
 * Si mode no se pasa, lee localStorage.
 */
export function formatSapTs(ts, mode) {
  if (!ts || ts.length < 14) return '—'
  const d = parseSapTs(ts)
  if (!d) return '—'
  const resolvedMode = mode ?? getTzMode()

  if (resolvedMode === 'local') {
    const day   = String(d.getDate()).padStart(2, '0')
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const year  = d.getFullYear()
    const hh    = String(d.getHours()).padStart(2, '0')
    const mm    = String(d.getMinutes()).padStart(2, '0')
    const ss    = String(d.getSeconds()).padStart(2, '0')
    return `${day}/${month}/${year} ${hh}:${mm}:${ss}`
  }

  // UTC (default)
  const day   = String(d.getUTCDate()).padStart(2, '0')
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const year  = d.getUTCFullYear()
  const hh    = String(d.getUTCHours()).padStart(2, '0')
  const mm    = String(d.getUTCMinutes()).padStart(2, '0')
  const ss    = String(d.getUTCSeconds()).padStart(2, '0')
  return `${day}/${month}/${year} ${hh}:${mm}:${ss}`
}

/** Versión corta sin segundos — para dashboards/charts */
export function formatSapTsShort(ts, mode) {
  if (!ts || ts.length < 12) return '—'
  const d = parseSapTs(ts)
  if (!d) return '—'
  const resolvedMode = mode ?? getTzMode()

  if (resolvedMode === 'local') {
    const day   = String(d.getDate()).padStart(2, '0')
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const year  = d.getFullYear()
    const hh    = String(d.getHours()).padStart(2, '0')
    const mm    = String(d.getMinutes()).padStart(2, '0')
    return `${day}/${month}/${year} ${hh}:${mm}`
  }

  const day   = String(d.getUTCDate()).padStart(2, '0')
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const year  = d.getUTCFullYear()
  const hh    = String(d.getUTCHours()).padStart(2, '0')
  const mm    = String(d.getUTCMinutes()).padStart(2, '0')
  return `${day}/${month}/${year} ${hh}:${mm}`
}

/** Etiqueta de día "DD/MM" para ejes de gráficos */
export function dayLabel(ts, mode) {
  const d = parseSapTs(ts)
  if (!d) return '?'
  const resolvedMode = mode ?? getTzMode()
  const day   = resolvedMode === 'local' ? d.getDate()       : d.getUTCDate()
  const month = resolvedMode === 'local' ? d.getMonth() + 1  : d.getUTCMonth() + 1
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}`
}

// ─── Conversión para inputs datetime-local ───────────────────────────────────
/**
 * Convierte un Date al string que espera <input type="datetime-local">.
 * - mode='utc'   → muestra la hora UTC en el input
 * - mode='local' → muestra la hora local en el input
 */
export function toInputDate(date, mode) {
  const resolvedMode = mode ?? getTzMode()
  if (resolvedMode === 'local') {
    // Formato "YYYY-MM-DDTHH:mm" en hora local
    const p = n => String(n).padStart(2, '0')
    return (
      `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
      `T${p(date.getHours())}:${p(date.getMinutes())}`
    )
  }
  // UTC: toISOString() ya da UTC, slice quita los segundos y la Z
  return date.toISOString().slice(0, 16)
}

/**
 * Convierte el string de un datetime-local a un Date en UTC.
 * - mode='utc'   → el input ya está en UTC, parsear directo
 * - mode='local' → el input está en hora local, convertir a UTC
 */
export function inputDateToDate(value, mode) {
  const resolvedMode = mode ?? getTzMode()
  if (resolvedMode === 'local') {
    // new Date('YYYY-MM-DDTHH:mm') sin Z → interpreta como local
    return new Date(value)
  }
  // UTC: agregar Z para que sea interpretado como UTC
  return new Date(value + ':00.000Z')
}
