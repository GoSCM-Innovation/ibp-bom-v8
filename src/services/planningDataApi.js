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
import { fetchVsmt } from './masterDataApi.js'
export { chunkByBytes, MAX_POST_BYTES } from './masterDataApi.js'   // byte-accurate POST chunking (shared)

const COM = '0720'
const READ_TIMEOUT  = 90000
const WRITE_TIMEOUT = 110000   // headroom under Vercel maxDuration (120s) for larger POST chunks
const CATALOG_TTL   = 24 * 60 * 60 * 1000   // 24 h

export const BASE_VERSION_ID = '__BASELINE'
// Max key-figure VALUES per POST. SAP allows 5000, but write time scales ~linearly
// with values (measured vs my400444: ~20 ms/value → 5000 values ≈ 110-135 s), which
// EXCEEDS both WRITE_TIMEOUT (110 s) and Vercel's maxDuration (120 s) → the POST is
// killed and the segment retried, making big POSTs SLOWER and error-prone. Capped at
// 2500 (≈ 53 s/POST) so every write finishes well under both limits; throughput is
// recovered through concurrency (PARALLEL_W × CONCURRENT_SEGMENTS), not bigger POSTs.
export const MAX_KF_VALUES_PER_POST = 2500
// Parallel read pages PER WORKER. Kept LOW on purpose: the dominant read cost is a
// fixed ~6 s per request (measured vs my400439 — flat across $skip depth and $orderby).
// Bigger pages amortise that fixed cost far better than many small ones, so we read
// FEW BIG pages, not many small. Concurrency comes from CONCURRENT_SEGMENTS workers;
// PARALLEL_R×CONCURRENT_SEGMENTS = max in-flight reads (2×6=12 of ~2.5 MB each).
export const PARALLEL_R = 2                  // parallel read pages per worker
// Parallel write POSTs per worker. Write throughput keeps climbing with concurrency
// (measured vs my400444, 2500-value POSTs, 0 errors): 12 POSTs→298, 16→354, 20→415
// values/s. 3 × CONCURRENT_SEGMENTS(6) = 18 concurrent POSTs (~390 values/s) is the
// chosen balance — ~30% over 12 without pushing the tenant to the max. (Combined with
// the 2500-value cap so each POST stays ~53 s, well under WRITE_TIMEOUT/maxDuration.)
export const PARALLEL_W = 3
export const COUNT_TOP  = 2                  // small $top for safe counting (never 0)
// Separate byte budgets (the hard ceiling is BYTES, not rows; Vercel caps the
// request/response body at ~4.5 MB). Reads get a SMALLER budget: large multi-MB
// read responses relayed through the proxy can arrive TRUNCATED under load, so we
// keep each read page well under the size where truncation appears (and page
// reads retry — see readKfPage). Mirrors the master-data fix.
export const WRITE_BYTE_BUDGET = 3_500_000   // POST body ceiling, well below ~4.5 MB
// GET response ceiling. Raised 900 KB → 2.5 MB: each request has a large FIXED cost
// (~6 s), so a 2.5 MB page (~5000 value-rows) reads ~2.5× more rows/s than a 900 KB
// one and stays safely under Vercel's ~4.5 MB serverless response limit. Verified the
// proxy relays 2.5 MB intact; the Content-Length truncation guard + page retry remain
// the safety net if a relay ever comes up short.
export const READ_BYTE_BUDGET  = 2_500_000
// Rows per COMMITTED segment. A KF is loaded in segments of this size, each committed
// before the next — so a transient failure only re-does the CURRENT segment (in a
// fresh transaction), never the whole KF, and committed segments are kept. Raised
// 20000 → 40000 (fewer transactions = fewer getTransactionID/IPP/commit cycles). Not
// higher because CONCURRENT_SEGMENTS workers each BUFFER a full segment in browser
// memory before writing (40000 × 6 ≈ 240k rows); the confirmation tail is already
// parallelised, so bigger segments give little extra benefit.
export const SEGMENT_SIZE = 40000
// Concurrent time-bucket workers (independent transactions → parallel). See the
// master-data note; a ceiling test showed throughput scaling with no errors to ~20
// concurrent POSTs. Measured 0 errors; K=6 ≈ 1505 rows/s end-to-end (~18 min/1.6M).
export const CONCURRENT_SEGMENTS = 6
// Max attempts PER SEGMENT. A failed attempt abandons its uncommitted transaction
// (SAP saves nothing without commit) and re-stages that segment, so retries never
// duplicate values within a committed transaction. Higher than before because each
// retry is now cheap (one segment, not the whole group).
export const MAX_SEGMENT_ATTEMPTS = 5

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

// Planning-area list exposed to this user (cached 24 h per connection). The
// service exposes an area as an entity set only if it's enabled for this service
// in the SAP_COM_0720 arrangement — usually one, sometimes several.
export async function fetchKfAreas(conn, session, { force = false, signal } = {}) {
  const ck = `ibp:kfareas:${conn.id}`
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(ck))
      if (cached && Date.now() - cached.ts < CATALOG_TTL) return cached.data
    } catch { /* ignore */ }
  }
  const areas = await discoverPlanningArea(conn, session, { signal })
  try { localStorage.setItem(ck, JSON.stringify({ ts: Date.now(), data: areas })) } catch { /* quota */ }
  return areas
}

// Catalog for ONE planning area: { pa, areas, dims, measures, labels, versions }.
// Cached per connection+area. If `pa` is omitted (or unknown), the first
// discovered area is used — so single-area tenants keep working with no selection.
export async function fetchKfCatalog(conn, session, { pa, force = false, signal } = {}) {
  const areas = await fetchKfAreas(conn, session, { force, signal })
  if (areas.length === 0) {
    throw new Error('El servicio PLANNING_DATA_API_SRV no expone ningún área de planificación para este usuario. Habilítela en el communication arrangement SAP_COM_0720.')
  }
  const area = (pa && areas.includes(pa)) ? pa : areas[0]
  const ck = `ibp:kfcatalog:${conn.id}:${area}`
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(ck))
      if (cached && Date.now() - cached.ts < CATALOG_TTL) return cached.data
    } catch { /* ignore */ }
  }
  const [{ dims, measures, labels }, versions] = await Promise.all([
    fetchKfMetadata(conn, session, area, { signal }),
    fetchVersions(conn, session, area, { signal }),
  ])
  const data = { pa: area, areas, dims, measures, labels, versions }
  try { localStorage.setItem(ck, JSON.stringify({ ts: Date.now(), data })) } catch { /* quota */ }
  return data
}

export function invalidateKfCatalog(connId) {
  try {
    const prefix = `ibp:kfcatalog:${connId}`
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k === `ibp:kfareas:${connId}` || (k && k.startsWith(prefix))) localStorage.removeItem(k)
    }
  } catch { /* ignore */ }
}

// ─── Read ──────────────────────────────────────────────────────────────────────

// Total record count at the requested level. Uses a small $top (never 0) so the
// inlinecount is computed without materialising the whole set (avoids ABAP TSV
// TNEW_PAGE_ALLOC_FAILED on detailed levels).
export async function countKf(conn, session, pa, { select, filter, signal, retries = 5, timeout } = {}) {
  let path = `/${pa}?$format=json&$top=${COUNT_TOP}&$inlinecount=allpages&$select=${qenc(select)}`
  if (filter) path += `&$filter=${qenc(filter)}`
  // Idempotent read → retry transient failures by default. Callers doing ADVISORY
  // checks (e.g. the level analysis) pass retries: 0 + a short timeout so a slow
  // detailed-level count fails fast instead of retrying for ~10 minutes.
  return withRetry(async () => {
    const resp = await pcall(conn, session, { path, signal, ...(timeout ? { timeout } : {}) })
    if (!resp.ok) throw await httpError(resp)
    const data = await resp.json()
    return parseInt(data?.d?.__count ?? '0', 10)
  }, { retries, signal })
}

// One page of key-figure rows. Caller drives pagination via skip/top.
// orderby (string[]): stable sort (the level columns) so $skip/$top windows can't
// overlap or skip rows under concurrent reads.
export async function readKfPage(conn, session, pa, { select, filter, skip = 0, top = 5000, orderby, signal } = {}) {
  let path = `/${pa}?$format=json&$select=${qenc(select)}&$top=${top}&$skip=${skip}`
  if (orderby && orderby.length) path += `&$orderby=${qenc(orderby.join(','))}`
  if (filter) path += `&$filter=${qenc(filter)}`
  // A page read is idempotent (same $skip/$top/$orderby → same rows), so it is safe
  // to retry. This lets a truncated-relay page (proxy 502) or transient 5xx recover
  // on its own WITHOUT discarding the segment. NOTE: writes are NOT retried (see
  // postKfChunk) — re-POSTing would duplicate values inside a live transaction.
  return withRetry(async () => {
    const resp = await pcall(conn, session, { path, signal })
    if (!resp.ok) throw await httpError(resp)
    const data = await resp.json()
    return (data?.d?.results ?? []).map(stripMeta)
  }, { retries: 5, signal })
}

function stripMeta(row) {
  const out = {}
  for (const k of Object.keys(row)) if (k !== '__metadata') out[k] = row[k]
  return out
}

// Distinct time periods present (as ISO strings) for a filter. Selecting only the
// period + one KF (no attributes) makes SAP aggregate to time-only level, returning
// one row per period — a cheap way to drive time-based partitioning of huge reads.
export async function fetchTimeBuckets(conn, session, pa, { timeField, kf, filter, signal } = {}) {
  let path = `/${pa}?$format=json&$select=${qenc(`${timeField},${kf}`)}&$top=5000`
  if (filter) path += `&$filter=${qenc(filter)}`
  const resp = await pcall(conn, session, { path, signal })
  if (!resp.ok) throw await httpError(resp)
  const data = await resp.json()
  const seen = new Set(), out = []
  for (const r of (data?.d?.results ?? [])) {
    const raw = r[timeField]
    if (raw == null || seen.has(raw)) continue
    seen.add(raw); out.push(odataDateToIso(raw))
  }
  return out.sort()
}

// ─── Diagnostics / safeguards ────────────────────────────────────────────────

// Detects which conversion attributes a key figure needs in $filter. Returns an
// ARRAY (subset of ['UOM','CURR']) — a single KF can require BOTH a target unit
// (UOMTOID) AND a target currency (CURRTOID) at once. SAP only names ONE missing
// attribute per response ("Add property X to a filter condition"), so we probe
// iteratively: supply each already-found attribute with a placeholder value
// (eq 'ZZZ' — the filter-tree check is value-independent) and re-read until SAP
// stops complaining about a conversion attribute. Capped at 2 rounds (UOM+CURR).
export async function detectConversions(conn, session, pa, kf, { signal } = {}) {
  const found = []
  for (let round = 0; round < 3; round++) {
    const probe = found.map(k => `${k === 'CURR' ? 'CURRTOID' : 'UOMTOID'} eq 'ZZZ'`).join(' and ')
    const cols  = ['PRDID', ...found.map(k => k === 'CURR' ? 'CURRTOID' : 'UOMTOID'), kf, 'PERIODID4_TSTAMP']
    let path = `/${pa}?$format=json&$top=1&$select=${qenc(cols.join(','))}`
    if (probe) path += `&$filter=${qenc(probe)}`
    const resp = await pcall(conn, session, { path, signal })
    if (resp.ok) break               // no further conversion attribute required
    const err = await httpError(resp).catch(() => null)
    const d = (err?.detail || '').toUpperCase()
    if (d.includes('UOMTOID') && !found.includes('UOM')) { found.push('UOM'); continue }
    if (d.includes('CURRTOID') && !found.includes('CURR')) { found.push('CURR'); continue }
    break                            // some other 4xx — no (more) known conversion
  }
  return found
}

// "Level signature": is `attr` a ROOT of the KF level (adding it raises the count)
// or DERIVED (count unchanged → resolved from master data)? Used to assist level
// definition and to detect disaggregation. Returns { root: bool, base, withAttr }.
export async function levelSignatureForAttr(conn, session, pa, { baseSelect, attr, filter, signal } = {}) {
  const base     = await countKf(conn, session, pa, { select: baseSelect, filter, signal })
  const withAttr = await countKf(conn, session, pa, { select: `${baseSelect},${attr}`, filter, signal })
  return { base, withAttr, root: withAttr > base }
}

// ─── Conversion master data (units / currencies) ─────────────────────────────
// When a KF requires a target unit (UOMTOID) or currency (CURRTOID), the user
// picks from the area's master data. That master lives in MASTER_DATA_API_SRV
// (com0720's default URL). The MDT name ends in UOMTO / CURRENCYTO; we locate it
// via the area's VSMT catalog. Returns [{ id, desc }] sorted by id.
export async function fetchConversionValues(conn, session, pa, kind, { signal } = {}) {
  const suffix    = kind === 'CURR' ? 'CURRENCYTO'  : 'UOMTO'
  const idField   = kind === 'CURR' ? 'CURRTOID'    : 'UOMTOID'
  const descField = kind === 'CURR' ? 'CURRTODESCR' : 'UOMTODESCR'
  const vsmt = await fetchVsmt(conn, session)
  const mdts = [...new Set(vsmt.filter(r => !pa || r.PlanningAreaID === pa).map(r => r.MasterDataTypeID))]
  const mdt  = mdts.find(m => (m || '').toUpperCase().endsWith(suffix))
  if (!mdt) return []
  // Read from MASTER_DATA_API_SRV (com0720 default URL — NO serviceRoot override).
  const resp = await proxyCall({
    connection: conn, session, com: COM,
    path: `/${mdt}?$format=json&$select=${idField},${descField}&$top=5000`, signal, timeout: READ_TIMEOUT,
  })
  if (!resp.ok) return []
  const data = await resp.json().catch(() => ({}))
  const seen = new Set(), out = []
  for (const r of (data?.d?.results ?? [])) {
    const id = r[idField]
    if (!id || seen.has(id)) continue
    seen.add(id); out.push({ id, desc: r[descField] || id })
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)))
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
const PARALLEL_UNSUPPORTED_KEY = id => `ibp:noParallelKf:${id}`

export async function initiateParallelProcess(conn, session, txId, { planningArea, versionId, scenarioId = '', transactionName = 'ibp-bom-kf' } = {}) {
  try {
    const cached = JSON.parse(localStorage.getItem(PARALLEL_UNSUPPORTED_KEY(conn.id)))
    if (cached && Date.now() - cached.ts < CATALOG_TTL) return null
  } catch { /* ignore */ }

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
    if (resp.status >= 400 && resp.status < 500) {
      try { localStorage.setItem(PARALLEL_UNSUPPORTED_KEY(conn.id), JSON.stringify({ ts: Date.now() })) } catch { /* ignore */ }
      return null
    }
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
  // NO retry here, on purpose. Staging is NOT idempotent: re-POSTing a chunk that
  // SAP already staged (after a proxy/gateway 5xx) duplicates values inside the
  // SAME transaction. The caller retries at the TRANSACTION level instead —
  // discard the uncommitted transaction and re-stage in a fresh one.
  const resp = await pcall(conn, session, { path: `/${pa}Trans`, method: 'POST', body, signal, csrf, timeout: WRITE_TIMEOUT })
  if (!resp.ok) {
    const err = await httpError(resp)
    const m = /invalid column name:\s*([A-Z0-9_]+)/i.exec(err.detail || '')
    if (m) { err.calculatedKf = m[1]; err.isCalculated = true }
    throw err
  }
  return resp.json().catch(() => ({}))
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
// Paged so the rejected-row count is complete on large error sets.
export async function readMessages(conn, session, pa, txId, { signal } = {}) {
  const base = `/${pa}Message?$format=json&$filter=${qenc(`Transactionid eq '${txId}'`)}`
  const top  = 5000
  const all  = []
  let skip = 0
  for (;;) {
    if (signal?.aborted) break
    const resp = await pcall(conn, session, { path: `${base}&$top=${top}&$skip=${skip}`, signal })
    if (!resp.ok) break
    const data = await resp.json().catch(() => ({}))
    const page = data?.d?.results ?? []
    all.push(...page)
    if (page.length < top) break
    skip += top
  }
  return all
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

// Adaptive sizing. SAP caps ~5000 key-figure values per POST; the hard ceiling is
// BYTES (Vercel caps the request/response body at ~4.5 MB). We size to the smaller.
const readBytesPerRow  = nFields => 500 + (nFields || 1) * 30   // GET response/row estimate
const writeBytesPerRow = nFields => 150 + (nFields || 1) * 25   // POST body/row estimate

// Rows per read page: bounded by the (smaller) read byte budget to survive the
// proxy relay without truncation. Field-count FALLBACK (underestimates value-heavy
// rows); prefer readRowsPerPageBytes with a measured bytes/row.
export function readRowsPerPage(nFields) {
  return Math.max(250, Math.min(10000, Math.floor(READ_BYTE_BUDGET / readBytesPerRow(nFields))))
}

// Rows per write chunk: the SMALLER of SAP's ≤5000-values cap and the write byte
// budget. nFields = columns per row (level attrs + key figures + time). nKf = key figures.
export function rowsPerChunk(nKf, nFields) {
  const byValues = Math.max(1, Math.min(5000, Math.floor(MAX_KF_VALUES_PER_POST / Math.max(1, nKf || 1))))
  if (!nFields) return byValues
  const byBytes = Math.max(1, Math.floor(WRITE_BYTE_BUDGET / writeBytesPerRow(nFields)))
  return Math.max(1, Math.min(byValues, byBytes))
}

// Byte-accurate sizing from a MEASURED bytes-per-row (see measureKfRowBytes).
export function readRowsPerPageBytes(bytesPerRow) {
  if (!bytesPerRow || bytesPerRow < 1) return readRowsPerPage(0)
  return Math.max(250, Math.min(10000, Math.floor(READ_BYTE_BUDGET / bytesPerRow)))
}
// nKf still caps by SAP's ≤5000 key-figure-values/POST rule; bytes cap the rest.
export function rowsPerChunkBytes(nKf, bytesPerRow) {
  const byValues = Math.max(1, Math.min(5000, Math.floor(MAX_KF_VALUES_PER_POST / Math.max(1, nKf || 1))))
  if (!bytesPerRow || bytesPerRow < 1) return byValues
  const byBytes = Math.max(1, Math.floor(WRITE_BYTE_BUDGET / bytesPerRow))
  return Math.max(1, Math.min(byValues, byBytes))
}

// Measures ACTUAL bytes/row from a small live sample with the SAME $select the read
// will use: GET response size (drives read truncation) and an approximate POST body
// size (drives Vercel's ~4.5 MB limit). Returns { readBpr, writeBpr, n } or null.
export async function measureKfRowBytes(conn, session, pa, { select, filter, signal, sample = 200 } = {}) {
  let path = `/${pa}?$format=json&$select=${qenc(select)}&$top=${sample}&$skip=0`
  if (filter) path += `&$filter=${qenc(filter)}`
  const text = await withRetry(async () => {
    const resp = await pcall(conn, session, { path, signal })
    if (!resp.ok) throw await httpError(resp)
    return resp.text()
  }, { retries: 5, signal })
  const rows = (JSON.parse(text)?.d?.results ?? []).map(stripMeta)
  if (rows.length === 0) return null
  const enc        = new TextEncoder()
  const readBytes  = enc.encode(text).length
  const writeBytes = enc.encode(JSON.stringify(rows)).length
  return { readBpr: Math.ceil(readBytes / rows.length), writeBpr: Math.ceil(writeBytes / rows.length), n: rows.length }
}
