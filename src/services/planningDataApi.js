// ─────────────────────────────────────────────────────────────────────────────
// planningDataApi.js — SAP IBP Planning Data API (key figures / dato transaccional)
//
// Service: /sap/opu/odata/IBP/PLANNING_DATA_API_SRV  ·  Comm. scenario SAP_COM_0720
// (the SAME scenario as master data, but a DIFFERENT service URL). Credentials are
// reused from connection.com0720; the service URL is derived from it.
//
// All behaviour here was validated against two real tenants (ASIBPTS @ my400444 and
// LAALIAXIS @ my301682). Key facts encoded below:
//  · The planning area is exposed as an entity set named like the area itself
//    (e.g. ASIBPTS). Read = GET /<PA>; write = POST /<PA>Trans (deep insert into
//    Nav<PA>); messages = /<PA>Message. The app DISCOVERS the area name from the
//    service document — it never assumes a fixed name.
//  · Read requires $select; quantity KF demand UOMTOID and value KF demand CURRTOID
//    in $filter (auto-detected). Counting MUST use a small $top, never $top=0
//    (which blows up with TSV_TNEW_PAGE_ALLOC_FAILED on detailed levels).
//  · SAP aggregates to the requested $select level (no dimension disaggregation).
//  · Write: getTransactionID → [InitiateParallelProcess] → POST <PA>Trans chunks →
//    commit → poll getExportResult → read <PA>Message. Function-import params go in
//    the QUERY string. Upsert semantics. Recommended ≤5000 key-figure values/POST.
//  · A calculated (non-editable) KF rejects the POST with HTTP 500
//    "invalid column name: <KF>".
// ─────────────────────────────────────────────────────────────────────────────

import { proxyCall } from './proxyCall.js'

const COM = '0720'
const READ_TIMEOUT  = 90000
const WRITE_TIMEOUT = 90000
const CATALOG_TTL   = 24 * 60 * 60 * 1000   // 24 h

export const BASE_VERSION_ID = '__BASELINE'
export const MAX_KF_VALUES_PER_POST = 5000  // SAP-recommended limit
export const PARALLEL_R = 4                  // parallel read pages
export const PARALLEL_W = 4                  // parallel write POSTs
export const COUNT_TOP  = 2                  // small $top for safe counting (never 0)

// Entity sets the service always exposes regardless of planning area.
const GENERIC_SETS = new Set(['KeyFigureDeltaDefinitionSet', 'ValueResultSet'])

// ─── Errors / retry ──────────────────────────────────────────────────────────

async function httpError(resp) {
  const body   = await resp.json().catch(() => ({}))
  const detail = typeof body?.detail === 'string' ? body.detail
               : typeof body?.error  === 'string' ? body.error
               : null
  const err = new Error(detail ? `[${resp.status}] ${detail}` : `HTTP ${resp.status}`)
  err.status = resp.status
  err.detail = detail || ''
  return err
}

async function withRetry(fn, { retries = 2, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn() }
    catch (e) {
      if (e?.name === 'AbortError' || signal?.aborted) throw e
      const transient = e?.status == null || e.status >= 500
      if (!transient || attempt >= retries) throw e
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
}

// ─── Service URL ───────────────────────────────────────────────────────────────

// Derives the PLANNING_DATA_API_SRV URL from the master-data (com0720) URL. Both
// live under the same /sap/opu/odata/IBP/ prefix and the same comm. scenario, so a
// service-name swap is safe and keeps a single configured endpoint per connection.
export function planningServiceRoot(connection) {
  const master = connection?.com0720?.url || ''
  if (!master) return ''
  if (/MASTER_DATA_API_SRV/i.test(master)) {
    return master.replace(/MASTER_DATA_API_SRV/i, 'PLANNING_DATA_API_SRV')
  }
  // Fallback: a bare host or a base path → append the standard service path.
  const trimmed = master.replace(/\/+$/, '')
  if (/\/sap\/opu\/odata\/ibp$/i.test(trimmed)) return `${trimmed}/PLANNING_DATA_API_SRV`
  if (/PLANNING_DATA_API_SRV/i.test(trimmed)) return trimmed
  try {
    const u = new URL(trimmed)
    return `${u.origin}/sap/opu/odata/IBP/PLANNING_DATA_API_SRV`
  } catch { return trimmed }
}

// Central helper: every call reuses com0720 credentials but targets the planning URL.
function pcall(conn, session, { path, method = 'GET', body, signal, csrf, fetchCsrf, timeout = READ_TIMEOUT } = {}) {
  const serviceRoot = planningServiceRoot(conn)
  return proxyCall({ connection: conn, session, com: COM, serviceRoot, path, method, body, signal, csrf, fetchCsrf, timeout })
}

const enc  = v => `%27${encodeURIComponent(v)}%27`     // OData quoted string literal
const qenc = v => encodeURIComponent(v)

// ─── Catalog discovery ─────────────────────────────────────────────────────────

// Returns the planning area entity-set name exposed to this user (e.g. ASIBPTS,
// LAALIAXIS). The area is the base set: not generic, not a <PA>Trans/<PA>Message.
export async function discoverPlanningArea(conn, session, { signal } = {}) {
  const resp = await pcall(conn, session, { path: '/?$format=json', signal, timeout: 110000 })
  if (!resp.ok) throw await httpError(resp)
  const data = await resp.json()
  const sets = data?.d?.EntitySets ?? []
  const base = sets.filter(s =>
    !GENERIC_SETS.has(s) && !s.endsWith('Trans') && !s.endsWith('Message')
  )
  return base   // usually length 1; UI lets the user pick if more than one
}

// Reads the service $metadata (XML) and extracts the dimensions and key figures of
// the given planning area, classified via sap:aggregation-role. Parsed with the
// browser DOMParser. Cached in localStorage (24 h) per connection.
export async function fetchKfMetadata(conn, session, pa, { signal } = {}) {
  const resp = await pcall(conn, session, { path: '/$metadata', signal, timeout: 110000 })
  if (!resp.ok) throw await httpError(resp)
  const xml  = await resp.text()
  const doc  = new DOMParser().parseFromString(xml, 'application/xml')
  const types = [...doc.getElementsByTagName('EntityType')]
  const et = types.find(t => t.getAttribute('Name') === pa)
  if (!et) throw new Error(`Planning area "${pa}" not found in service metadata`)

  const dims = [], measures = [], labels = {}
  for (const p of [...et.getElementsByTagName('Property')]) {
    const name = p.getAttribute('Name')
    const role = p.getAttributeNS('http://www.sap.com/Protocols/SAPData', 'aggregation-role')
              || p.getAttribute('sap:aggregation-role')
    const label = p.getAttributeNS('http://www.sap.com/Protocols/SAPData', 'label')
              || p.getAttribute('sap:label') || name
    labels[name] = label
    if (role === 'measure' || (p.getAttribute('Type') || '').endsWith('Decimal')) measures.push(name)
    else dims.push(name)
  }
  return { dims, measures, labels }
}

// Lists planning versions of the area: { id, name } (id '' / __BASELINE = base).
export async function fetchVersions(conn, session, pa, { signal } = {}) {
  const resp = await pcall(conn, session, {
    path: `/${pa}?$select=VERSIONID,VERSIONNAME&$format=json`, signal,
  })
  if (!resp.ok) throw await httpError(resp)
  const data = await resp.json()
  const rows = data?.d?.results ?? []
  return rows.map(r => ({ id: r.VERSIONID, name: r.VERSIONNAME || r.VERSIONID }))
}

// Full per-connection catalog: { pa, dims, measures, labels, versions }. Cached 24 h.
export async function fetchKfCatalog(conn, session, { force = false, signal } = {}) {
  const ck = `ibp:kfcatalog:${conn.id}`
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(ck))
      if (cached && Date.now() - cached.ts < CATALOG_TTL) return cached.data
    } catch { /* ignore */ }
  }
  const areas = await discoverPlanningArea(conn, session, { signal })
  if (areas.length === 0) {
    throw new Error('El servicio PLANNING_DATA_API_SRV no expone ningún área de planificación para este usuario. Habilítela en el communication arrangement SAP_COM_0720.')
  }
  const pa = areas[0]
  const [{ dims, measures, labels }, versions] = await Promise.all([
    fetchKfMetadata(conn, session, pa, { signal }),
    fetchVersions(conn, session, pa, { signal }),
  ])
  const data = { pa, areas, dims, measures, labels, versions }
  try { localStorage.setItem(ck, JSON.stringify({ ts: Date.now(), data })) } catch { /* quota */ }
  return data
}

export function invalidateKfCatalog(connId) {
  try { localStorage.removeItem(`ibp:kfcatalog:${connId}`) } catch { /* ignore */ }
}

// ─── Read ──────────────────────────────────────────────────────────────────────

// Total record count at the requested level. Uses a small $top (never 0) so the
// inlinecount is computed without materialising the whole set (avoids ABAP TSV
// TNEW_PAGE_ALLOC_FAILED on detailed levels).
export async function countKf(conn, session, pa, { select, filter, signal } = {}) {
  let path = `/${pa}?$format=json&$top=${COUNT_TOP}&$inlinecount=allpages&$select=${qenc(select)}`
  if (filter) path += `&$filter=${qenc(filter)}`
  const resp = await pcall(conn, session, { path, signal })
  if (!resp.ok) throw await httpError(resp)
  const data = await resp.json()
  return parseInt(data?.d?.__count ?? '0', 10)
}

// One page of key-figure rows. Caller drives pagination via skip/top.
export async function readKfPage(conn, session, pa, { select, filter, skip = 0, top = 5000, signal } = {}) {
  let path = `/${pa}?$format=json&$select=${qenc(select)}&$top=${top}&$skip=${skip}`
  if (filter) path += `&$filter=${qenc(filter)}`
  const resp = await pcall(conn, session, { path, signal })
  if (!resp.ok) throw await httpError(resp)
  const data = await resp.json()
  return (data?.d?.results ?? []).map(stripMeta)
}

function stripMeta(row) {
  const out = {}
  for (const k of Object.keys(row)) if (k !== '__metadata') out[k] = row[k]
  return out
}

// ─── Diagnostics / safeguards ────────────────────────────────────────────────

// Detects whether a key figure needs a conversion attribute in $filter:
// returns 'UOM' | 'CURR' | null. Done with a tiny read WITHOUT the conversion
// filter — SAP replies "Add property UOMTOID/CURRTOID to a filter condition".
export async function detectConversion(conn, session, pa, kf, { signal } = {}) {
  const path = `/${pa}?$format=json&$top=1&$select=${qenc(`PRDID,${kf},PERIODID4_TSTAMP`)}`
  const resp = await pcall(conn, session, { path, signal })
  if (resp.ok) return null
  const err = await httpError(resp).catch(() => null)
  const d = (err?.detail || '').toUpperCase()
  if (d.includes('UOMTOID')) return 'UOM'
  if (d.includes('CURRTOID')) return 'CURR'
  return null   // some other 4xx — treat as no known conversion
}

// "Level signature": is `attr` a ROOT of the KF level (adding it raises the count)
// or DERIVED (count unchanged → resolved from master data)? Used to assist level
// definition and to detect disaggregation. Returns { root: bool, base, withAttr }.
export async function levelSignatureForAttr(conn, session, pa, { baseSelect, attr, filter, signal } = {}) {
  const base     = await countKf(conn, session, pa, { select: baseSelect, filter, signal })
  const withAttr = await countKf(conn, session, pa, { select: `${baseSelect},${attr}`, filter, signal })
  return { base, withAttr, root: withAttr > base }
}

// ─── Write transaction ──────────────────────────────────────────────────────────

export async function fetchCsrf(conn, session, { signal } = {}) {
  const resp = await pcall(conn, session, { fetchCsrf: true, signal })
  if (!resp.ok) throw await httpError(resp)
  return resp.json()   // { csrfToken, cookies }
}

// Step 1 — obtain a transaction ID (GUID, ≤32 chars).
export async function getTransactionId(conn, session, { signal } = {}) {
  return withRetry(async () => {
    const resp = await pcall(conn, session, { path: '/getTransactionID?$format=json', timeout: 90000, signal })
    if (!resp.ok) throw await httpError(resp)
    const data = await resp.json()
    const tx = data?.d?.Value
    if (!tx) throw new Error('getTransactionID did not return a value')
    return tx
  }, { signal })
}

// Step 2 (optional, best-effort) — enable server-side parallel processing.
// Params go in the QUERY string (POST with empty body). 4xx → returns null.
export async function initiateParallelProcess(conn, session, txId, { planningArea, versionId, scenarioId = '', transactionName = 'ibp-bom-kf' } = {}) {
  const q = [
    `Transactionid=${enc(txId)}`,
    `VersionID=${enc(versionId || '')}`,
    `ScenarioID=${enc(scenarioId)}`,
    `PlanningArea=${enc(planningArea)}`,
    `TransactionName=${enc(transactionName)}`,
    '$format=json',
  ].join('&')
  const resp = await pcall(conn, session, { path: `/InitiateParallelProcess?${q}`, method: 'POST', timeout: 20000 })
  if (!resp.ok) {
    if (resp.status >= 400 && resp.status < 500) return null
    throw await httpError(resp)
  }
  return resp.json().catch(() => ({}))
}

// Step 3 — POST one chunk of rows (deep insert into Nav<PA>). `fields` is the
// ordered column list for AggregationLevelFieldsString. With doCommit=true the
// chunk is committed immediately (low-volume path); otherwise commit() is required.
// A calculated KF surfaces here as HTTP 500 "invalid column name: <KF>".
export async function postKfChunk(conn, session, pa, txId, rows, { fields, versionId, scenarioId, doCommit = false, signal, csrf } = {}) {
  const body = {
    Transactionid: txId,
    AggregationLevelFieldsString: fields,
    DoCommit: !!doCommit,
    ...(versionId  ? { VersionID:  versionId  } : {}),
    ...(scenarioId ? { ScenarioID: scenarioId } : {}),
    [`Nav${pa}`]: rows,
  }
  return withRetry(async () => {
    const resp = await pcall(conn, session, { path: `/${pa}Trans`, method: 'POST', body, signal, csrf, timeout: WRITE_TIMEOUT })
    if (!resp.ok) {
      const err = await httpError(resp)
      const m = /invalid column name:\s*([A-Z0-9_]+)/i.exec(err.detail || '')
      if (m) { err.calculatedKf = m[1]; err.isCalculated = true }
      throw err
    }
    return resp.json().catch(() => ({}))
  }, { signal })
}

// Step 4 — commit all staged POSTs of the transaction (async on the SAP side).
export async function commitTransaction(conn, session, txId, { signal, csrf } = {}) {
  return withRetry(async () => {
    const resp = await pcall(conn, session, { path: `/commit?P_TransactionID=${enc(txId)}`, method: 'POST', signal, csrf, timeout: WRITE_TIMEOUT })
    if (!resp.ok) throw await httpError(resp)
    return resp.json().catch(() => ({}))
  }, { retries: 1, signal })
}

// Step 5 — import status: PROCESSED | PROCESSED_WITH_ERRORS | ERROR | <other> | null(4xx).
export async function getExportResult(conn, session, txId, { signal } = {}) {
  const resp = await pcall(conn, session, { path: `/getExportResult?P_TransactionID=${enc(txId)}&$format=json`, signal })
  if (!resp.ok) {
    if (resp.status >= 400 && resp.status < 500) return null
    throw await httpError(resp)
  }
  const data = await resp.json().catch(() => ({}))
  const results = data?.d?.results ?? (Array.isArray(data?.d) ? data.d : [])
  const out = {}
  for (const it of results) if (it?.Name != null) out[it.Name] = it.Value
  return out
}

// Poll until the async commit finishes. Returns the final status string.
export async function waitForProcessed(conn, session, txId, { timeoutMs = 600000, intervalMs = 3000, signal } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) return 'ABORTED'
    let res
    try { res = await getExportResult(conn, session, txId, { signal }) }
    catch (e) { if (e?.name === 'AbortError') return 'ABORTED'; res = undefined }
    if (res === null) return 'UNSUPPORTED'
    const st = res?.Status
    if (st === 'PROCESSED') return 'PROCESSED'
    if (st === 'ERROR') return 'ERROR'
    if (st === 'PROCESSED_WITH_ERRORS') return 'PROCESSED_WITH_ERRORS'
    if (Date.now() >= deadline) return 'TIMEOUT'
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

// Step 6 — per-transaction messages (errors/info). Filtered by transaction id.
export async function readMessages(conn, session, pa, txId, { signal } = {}) {
  const path = `/${pa}Message?$format=json&$filter=${qenc(`Transactionid eq '${txId}'`)}`
  const resp = await pcall(conn, session, { path, signal })
  if (!resp.ok) return []
  const data = await resp.json().catch(() => ({}))
  return data?.d?.results ?? []
}

// ─── Time / value helpers ────────────────────────────────────────────────────

// OData v2 read returns timestamps as /Date(ms)/; the import body expects ISO
// "YYYY-MM-DDTHH:mm:ss". Convert between the two.
export function odataDateToIso(val) {
  if (typeof val !== 'string') return val
  const m = val.match(/\/Date\((\d+)([+-]\d+)?\)\//)
  if (!m) return val
  const d = new Date(parseInt(m[1], 10))
  return d.toISOString().slice(0, 19)   // drop milliseconds + Z
}

// Adaptive chunk size: SAP caps ~5000 key-figure values per POST. With nKf key
// figures per row, rows-per-chunk = floor(MAX / nKf).
export function rowsPerChunk(nKf) {
  const n = Math.max(1, nKf || 1)
  return Math.max(1, Math.min(5000, Math.floor(MAX_KF_VALUES_PER_POST / n)))
}
