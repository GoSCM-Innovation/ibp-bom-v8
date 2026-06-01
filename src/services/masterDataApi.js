import { proxyCall } from './proxyCall.js'

const COM = '0720'
const VSMT_TTL = 24 * 60 * 60 * 1000  // 24 h

// Builds a readable Error from a failed proxy response. The proxy returns
// { error, detail } (both strings); we surface "[status] detail" and never let
// a non-string coerce into the useless "[object Object]". The HTTP status is
// attached so retry logic can tell transient (5xx) from permanent (4xx) errors.
async function httpError(resp) {
  const body   = await resp.json().catch(() => ({}))
  const detail = typeof body?.detail === 'string' ? body.detail
               : typeof body?.error  === 'string' ? body.error
               : null
  const err = new Error(detail ? `[${resp.status}] ${detail}` : `HTTP ${resp.status}`)
  err.status = resp.status
  return err
}

// Retries a request thunk on TRANSIENT failures (5xx, or network/timeout with no
// status). Never retries 4xx (data errors) or user-cancellation aborts.
async function withRetry(fn, { retries = 2, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn() }
    catch (e) {
      if (e?.name === 'AbortError' || signal?.aborted) throw e   // user cancel
      const transient = e?.status == null || e.status >= 500     // network/timeout or 5xx
      if (!transient || attempt >= retries) throw e
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
}

export const PAGE_SIZE    = 2000   // default rows per read page (overridable, see pageSizeFor)
export const CHUNK_SIZE   = 500    // default rows per write POST (overridable, see chunkSizeFor)
export const PARALLEL_R   = 4      // parallel read pages  (3× speedup measured)
export const PARALLEL_W   = 4      // parallel write POSTs

// Adaptive batch sizing. The hard limit is BYTES, not rows: a Vercel serverless
// function caps the request AND response body at ~4.5 MB. A page/chunk that
// exceeds it makes the proxy return 500 (which then forces a transaction-level
// retry). We size every batch to a safe BYTE_BUDGET well under that ceiling.
//
// Bytes-per-row is estimated from the field count with a fixed per-row envelope
// plus a per-field cost — a model fitted to measured rows (e.g. AS1PRODUCT 62
// fields ≈ 1.7 KB read / 1.2 KB POST; AS1UOMTO 6 fields ≈ 0.57 KB / 44 B). The
// estimates are deliberately conservative (over-estimate) so text-heavy rows
// still stay under budget. SAP also recommends max 5 000 rows per import.
const BYTE_BUDGET = 2_800_000   // safe ceiling, well below Vercel's ~4.5 MB
const readBytesPerRow  = nFields => 500 + nFields * 30   // GET response (all fields + metadata)
const writeBytesPerRow = nFields => 150 + nFields * 25   // POST body (projected, no readonly/metadata)

export function chunkSizeFor(nFields) {
  if (!nFields || nFields < 1) return CHUNK_SIZE
  return Math.max(500, Math.min(5000, Math.floor(BYTE_BUDGET / writeBytesPerRow(nFields))))
}
export function pageSizeFor(nFields) {
  if (!nFields || nFields < 1) return PAGE_SIZE
  return Math.max(500, Math.min(5000, Math.floor(BYTE_BUDGET / readBytesPerRow(nFields))))
}

// ─── VSMT catalog ────────────────────────────────────────────────────────────

export async function fetchVsmt(conn, session) {
  const ck = `ibp:vsmt:${conn.id}`
  try {
    const cached = JSON.parse(localStorage.getItem(ck))
    if (cached && Date.now() - cached.ts < VSMT_TTL) return cached.data
  } catch {}

  const resp = await proxyCall({
    connection: conn, session, com: COM,
    path: '/VersionSpecificMasterDataTypes?$format=json' +
          '&$select=PlanningAreaID,VersionID,MasterDataTypeID,PlanningAreaDescr,VersionName',
  })
  if (!resp.ok) throw await httpError(resp)
  const data  = await resp.json()
  const rows  = data?.d?.results ?? []

  try { localStorage.setItem(ck, JSON.stringify({ ts: Date.now(), data: rows })) } catch {}
  return rows
}

export function invalidateVsmtCache(connId) {
  try { localStorage.removeItem(`ibp:vsmt:${connId}`) } catch {}
}

// ─── Importable MDT catalog ──────────────────────────────────────────────────

// Returns the set of MasterDataTypeIDs that can be IMPORTED, i.e. those that
// expose a "<MDT>Trans" entity set. Reference and virtual master data types do
// not generate a Trans entity set (per SAP docs) and therefore cannot be loaded.
// The service document ("/?$format=json") lists every entity set; we keep the
// names ending in "Trans". Cached in localStorage (24 h) like the VSMT catalog.
export async function fetchImportableMdts(conn, session) {
  const ck = `ibp:importable:${conn.id}`
  try {
    const cached = JSON.parse(localStorage.getItem(ck))
    if (cached && Date.now() - cached.ts < VSMT_TTL) return new Set(cached.data)
  } catch { /* ignore cache read errors */ }

  // The service document can be slow on a cold tenant — allow a long timeout.
  const resp = await proxyCall({
    connection: conn, session, com: COM,
    path: '/?$format=json',
    timeout: 110000,
  })
  if (!resp.ok) throw await httpError(resp)
  const data = await resp.json()
  const sets = data?.d?.EntitySets ?? []
  const importable = sets
    .filter(s => s.endsWith('Trans'))
    .map(s => s.slice(0, -'Trans'.length))

  try { localStorage.setItem(ck, JSON.stringify({ ts: Date.now(), data: importable })) } catch { /* ignore quota errors */ }
  return new Set(importable)
}

export function invalidateImportableCache(connId) {
  try { localStorage.removeItem(`ibp:importable:${connId}`) } catch { /* ignore */ }
}

// Converts the flat VSMT rows into a structured catalog:
// { [paId]: { desc, versions: [{ id, name, mdts: string[] }] } }
export function buildCatalog(vsmt) {
  const map = {}
  for (const r of vsmt) {
    const pa = r.PlanningAreaID
    if (!map[pa]) map[pa] = { desc: r.PlanningAreaDescr || pa, versions: {} }
    const v = r.VersionID
    if (!map[pa].versions[v]) map[pa].versions[v] = { name: r.VersionName || v, mdts: new Set() }
    map[pa].versions[v].mdts.add(r.MasterDataTypeID)
  }
  for (const pa of Object.keys(map)) {
    const vs = map[pa].versions
    map[pa].versions = Object.entries(vs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, { name, mdts }]) => ({ id, name, mdts: [...mdts].sort() }))
  }
  return map
}

// ─── Read ─────────────────────────────────────────────────────────────────────

// Reads AND writes can be slow on some tenants/versions (a version-filtered read
// was measured at 60+ s; staging POSTs can also exceed 30 s), so allow up to 90 s
// (under Vercel's maxDuration) instead of the 30 s proxy default.
const READ_TIMEOUT  = 90000
const WRITE_TIMEOUT = 90000

// Returns total record count using $inlinecount (no extra $count endpoint needed).
export async function fetchCount(conn, session, name, { planningArea, versionId, signal } = {}) {
  const filter = buildFilter(planningArea, versionId)
  let path = `/${name}?$format=json&$top=0&$inlinecount=allpages`
  if (filter) path += `&$filter=${encodeURIComponent(filter)}`
  const resp = await proxyCall({ connection: conn, session, com: COM, path, signal, timeout: READ_TIMEOUT })
  if (!resp.ok) throw await httpError(resp)
  const data = await resp.json()
  return parseInt(data?.d?.__count ?? '0', 10)
}

// Fetches one page of rows (2 000 by default). Uses explicit $skip — this tenant
// never returns __next, so the caller drives pagination manually.
export async function readEntityPage(conn, session, name, { skip = 0, top = PAGE_SIZE, planningArea, versionId, signal } = {}) {
  const filter = buildFilter(planningArea, versionId)
  let path = `/${name}?$format=json&$top=${top}&$skip=${skip}`
  if (filter) path += `&$filter=${encodeURIComponent(filter)}`
  const resp = await proxyCall({ connection: conn, session, com: COM, path, signal, timeout: READ_TIMEOUT })
  if (!resp.ok) throw await httpError(resp)
  const data = await resp.json()
  return (data?.d?.results ?? []).map(stripMeta)
}

// Reads the first `top` rows for preview (used by the Preview button).
export async function previewEntity(conn, session, name, { planningArea, versionId, top = 100 } = {}) {
  return readEntityPage(conn, session, name, { skip: 0, top, planningArea, versionId })
}

// Returns the field names of an MDT by reading one sample row.
// - Returns string[] when a sample row exists.
// - Returns null ONLY when the entity genuinely has no rows (empty in that
//   area/version) — the schema can't be inferred from a sample then.
// - Retries transient read failures; throws if every attempt fails, so callers
//   can tell "empty" (null) apart from "couldn't read" (throw) and avoid the
//   unsafe "send all fields" fallback on a transient glitch.
export async function fetchFieldNames(conn, session, name, { planningArea, versionId, signal, retries = 2 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const rows = await readEntityPage(conn, session, name, { skip: 0, top: 1, planningArea, versionId, signal })
      return rows.length ? Object.keys(rows[0]) : null
    } catch (e) {
      if (e?.name === 'AbortError') throw e   // cancelled — don't retry
      lastErr = e
      if (attempt < retries) await new Promise(r => setTimeout(r, 1500))
    }
  }
  throw lastErr
}

// ─── Write ────────────────────────────────────────────────────────────────────

// Obtains a CSRF token + session cookies once, to be reused across the many POSTs
// of a transaction (chunks + commit). Avoids the proxy re-fetching CSRF on every
// POST — the main cause of slow staging and timeout-induced 500s.
export async function fetchCsrf(conn, session, { signal } = {}) {
  const resp = await proxyCall({ connection: conn, session, com: COM, fetchCsrf: true, signal })
  if (!resp.ok) throw await httpError(resp)
  return resp.json()   // { csrfToken, cookies }
}

// Step 1: obtain a TransactionID from SAP IBP.
// If versionId is empty/null, falls back to __BASELINE — the documented
// identifier for the base version in /IBP/MASTER_DATA_API_SRV.
export const BASE_VERSION_ID = '__BASELINE'

export async function getTransactionId(conn, session, { transactionName, versionId, masterDataTypeId, planningArea, signal }) {
  const encStr = v => `%27${encodeURIComponent(v)}%27`
  const params = [
    `TransactionName=${encStr(transactionName || 'ibp-bom-migration')}`,
    `VersionID=${encStr(versionId || BASE_VERSION_ID)}`,
    `TransactionID=${encStr('')}`,
    `MasterDataTypeID=${encStr(masterDataTypeId)}`,
    `PlanningArea=${encStr(planningArea)}`,
    '$format=json',
  ].join('&')

  // GetTransactionID can take 60+ seconds on some IBP tenants — explicit 90 s timeout + retry on transient failures.
  const data = await withRetry(async () => {
    const resp = await proxyCall({ connection: conn, session, com: COM, path: `/GetTransactionID?${params}`, timeout: 90000, signal })
    if (!resp.ok) throw await httpError(resp)
    return resp.json()
  }, { signal })
  const txId = data?.d?.Value
  if (!txId) throw new Error('GetTransactionID did not return a TransactionID')
  return txId
}

// Step 2: stage one chunk of rows via deep-insert to <NAME>Trans/Nav<NAME>.
//
//   deleteEntries=false → upsert: create/update the given rows.
//   deleteEntries=true  → delete: rows must contain the KEY fields of the
//                          records to remove (SAP deletes the listed records).
//
// IMPORTANT — a single TransactionID must use a CONSISTENT DeleteEntries value
// across all its POSTs. SAP IBP rejects mixing true/false in one transaction
// ("Create a new transaction ID to use a different DeleteEntries value").
// A full-replace migration therefore uses TWO separate transactions: first a
// delete transaction (commit), then a load transaction.
//
// planningArea + versionId must be top-level fields in the POST body to tell
// SAP IBP which version to target (per official API documentation). Omitting
// them makes SAP default to __BASELINE regardless of the GetTransactionID
// VersionID.
export async function postTransChunk(conn, session, name, transactionId, rows, { deleteEntries = false, planningArea, versionId, signal, csrf } = {}) {
  const cleanRows = stripReadonlyFields(rows)
  const attrs = cleanRows.length ? Object.keys(cleanRows[0]).join(',') : ''

  // Version context: include PlanningAreaID + VersionID only when provided.
  // Omitting VersionID (or passing __BASELINE) targets the base version.
  const versionCtx = {
    ...(planningArea ? { PlanningAreaID: planningArea } : {}),
    ...(versionId    ? { VersionID:      versionId    } : {}),
  }

  const body = {
    TransactionID:       transactionId,
    ...versionCtx,
    DoCommit:            false,
    DeleteEntries:       deleteEntries,
    RequestedAttributes: attrs,
    [`Nav${name}`]:      { results: cleanRows },
  }
  // NO retry here, on purpose. Staging is NOT idempotent: if a POST times out at
  // the proxy/gateway (5xx) AFTER SAP already staged the rows, re-sending the
  // same chunk stages a SECOND copy of every key in the SAME transaction. On
  // commit SAP rejects BOTH copies of each duplicated key (error 119 "Duplicate
  // master data") → the record is lost, not just the extra. The caller instead
  // retries at the TRANSACTION level: discard the uncommitted transaction and
  // re-stage in a fresh one (re-applying upserts across transactions is safe).
  const resp = await proxyCall({
    connection: conn, session, com: COM,
    path: `/${name}Trans`, method: 'POST', body, signal, csrf, timeout: WRITE_TIMEOUT,
  })
  if (!resp.ok) throw await httpError(resp)
  return resp.json().catch(() => ({}))
}

// Reads ALL records for the given version and returns just their business-key
// columns — used to stage deletes for a full-replace migration. Key field
// names are discovered from the first record's __metadata.uri.
export async function readKeyRows(conn, session, name, { planningArea, versionId, signal } = {}) {
  const filter = buildFilter(planningArea, versionId)
  let path = `/${name}?$format=json&$top=${PAGE_SIZE}&$skip=0`
  if (filter) path += `&$filter=${encodeURIComponent(filter)}`
  const resp = await proxyCall({ connection: conn, session, com: COM, path, signal })
  if (!resp.ok) throw await httpError(resp)
  const data  = await resp.json()
  const first = data?.d?.results ?? []
  if (first.length === 0) return { keyNames: [], rows: [] }

  const keyNames = parseKeyNames(first[0]?.__metadata?.uri)
  if (keyNames.length === 0) return { keyNames: [], rows: [] }

  const pick = r => { const o = {}; keyNames.forEach(k => { o[k] = r[k] }); return o }
  const rows = first.map(pick)

  // Subsequent pages — tenant never returns __next, so drive $skip manually.
  if (first.length === PAGE_SIZE) {
    let skip = PAGE_SIZE
    for (;;) {
      const page = await readEntityPage(conn, session, name, { skip, top: PAGE_SIZE, planningArea, versionId, signal })
      rows.push(...page.map(pick))
      if (page.length < PAGE_SIZE) break
      skip += PAGE_SIZE
    }
  }
  return { keyNames, rows }
}

// Step 3: commit — permanently saves all staged data for this TransactionID.
export async function commitTransaction(conn, session, transactionId, { signal, csrf } = {}) {
  return withRetry(async () => {
    const resp = await proxyCall({
      connection: conn, session, com: COM,
      path: `/Commit?P_TransactionID=%27${encodeURIComponent(transactionId)}%27`,
      method: 'POST', signal, csrf, timeout: WRITE_TIMEOUT,
    })
    if (!resp.ok) throw await httpError(resp)
    return resp.json().catch(() => ({}))
  }, { retries: 1, signal })
}

// Step 3b (optional): enable server-side parallel processing for this transaction.
// Call after GetTransactionID and before the first postTransChunk.
// Returns null and does NOT throw on HTTP 4xx so callers treat it as best-effort.
//
// Parameter names MUST match the function import in $metadata exactly: bare
// names (NO "P_" prefix), and "PlanningArea" (not "PlanningAreaID"). VersionID
// is REQUIRED — omitting it returns 404 "Invalid Function Import Parameter
// 'VersionID'". (The sibling Commit/GetExportResult imports DO use a P_ prefix;
// these don't — they mirror GetTransactionID instead.)
//
// If a tenant genuinely doesn't support it we cache the 4xx per connection
// (VSMT_TTL) and stop calling, so it doesn't spam the console with handled
// errors or waste a round-trip per table.
const PARALLEL_UNSUPPORTED_KEY = id => `ibp:noParallel:${id}`

export async function initiateParallelProcess(conn, session, transactionId, { planningArea, versionId, masterDataTypeId } = {}) {
  try {
    const cached = JSON.parse(localStorage.getItem(PARALLEL_UNSUPPORTED_KEY(conn.id)))
    if (cached && Date.now() - cached.ts < VSMT_TTL) return null
  } catch { /* ignore cache read errors */ }

  const enc = v => `%27${encodeURIComponent(v)}%27`
  let path = `/InitiateParallelProcess?TransactionID=${enc(transactionId)}`
    + `&VersionID=${enc(versionId || BASE_VERSION_ID)}`   // required
  if (masterDataTypeId) path += `&MasterDataTypeID=${enc(masterDataTypeId)}`
  if (planningArea)     path += `&PlanningArea=${enc(planningArea)}`
  path += '&$format=json'
  // Best-effort optimisation — short timeout so a slow/unsupported tenant doesn't
  // waste the full window before the real load starts.
  const resp = await proxyCall({
    connection: conn, session, com: COM,
    path,
    method: 'POST', timeout: 20000,
  })
  if (!resp.ok) {
    if (resp.status >= 400 && resp.status < 500) {
      // Endpoint unavailable on this tenant — remember it so we stop calling.
      try { localStorage.setItem(PARALLEL_UNSUPPORTED_KEY(conn.id), JSON.stringify({ ts: Date.now() })) } catch { /* ignore */ }
      return null
    }
    throw await httpError(resp)
  }
  return resp.json().catch(() => ({}))
}

// Step 3c: retrieve the transaction's import result. SAP returns a ValueResultSet
// of { Name, Value } pairs (e.g. [{ Name: 'Status', Value: 'PROCESSED' }]), which
// this flattens into a plain object { Status: 'PROCESSED', ... }.
// Returns null when the endpoint is not available (4xx).
export async function getExportResult(conn, session, transactionId, { signal } = {}) {
  const resp = await proxyCall({
    connection: conn, session, com: COM,
    path: `/GetExportResult?P_TransactionID=%27${encodeURIComponent(transactionId)}%27`,
    signal,
  })
  if (!resp.ok) {
    if (resp.status >= 400 && resp.status < 500) return null
    throw await httpError(resp)
  }
  const data    = await resp.json().catch(() => ({}))
  const results = data?.d?.results ?? (Array.isArray(data?.d) ? data.d : null)
  if (!results) return data?.d ?? null
  const out = {}
  for (const item of results) {
    if (item?.Name != null) out[item.Name] = item.Value
  }
  return out
}

// Step 3d: SAP IBP commits asynchronously — right after Commit the data is still
// being applied (GetExportResult Status = 'PROCESSING') and a read would return
// stale data. Poll until Status is PROCESSED/ERROR or the timeout elapses.
// Returns 'PROCESSED' | 'ERROR' | 'TIMEOUT' | 'UNSUPPORTED'.
export async function waitForProcessed(conn, session, transactionId, { timeoutMs = 60000, intervalMs = 2000, signal } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) return 'ABORTED'
    let res
    try { res = await getExportResult(conn, session, transactionId, { signal }) }
    catch (e) { if (e?.name === 'AbortError') return 'ABORTED'; res = undefined }  // transient — retry
    if (res === null) return 'UNSUPPORTED'     // 4xx — endpoint not available
    const status = res?.Status
    if (status === 'PROCESSED') return 'PROCESSED'
    if (status === 'ERROR')     return 'ERROR'
    if (Date.now() >= deadline) return 'TIMEOUT'
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

// Step 4: read per-row error/info messages after commit.
// Uses $expand=Nav<NAME> to pull the failing record's key/attribute values
// alongside each message (per SAP documentation). Some tenants reject the
// expand, so we fall back to the plain message read on failure.
export async function readMessages(conn, session, name, transactionId, { signal } = {}) {
  const filter   = `TransactionID eq %27${encodeURIComponent(transactionId)}%27`
  const basePath = `/${name}Message?$format=json&$filter=${filter}`

  // Page through ALL messages (the tenant caps a page at PAGE_SIZE and never
  // returns __next), so the rejected-row count is complete even on large loads.
  // Try $expand first; if the tenant rejects it, fall back to the plain read.
  let useExpand = true
  const all = []
  let skip = 0
  for (;;) {
    if (signal?.aborted) break
    const suffix = `&$top=${PAGE_SIZE}&$skip=${skip}${useExpand ? `&$expand=Nav${name}` : ''}`
    const resp   = await proxyCall({ connection: conn, session, com: COM, path: basePath + suffix, signal })
    if (!resp.ok) {
      if (useExpand && skip === 0) { useExpand = false; continue }  // retry first page without expand
      break
    }
    const data = await resp.json().catch(() => ({}))
    const page = data?.d?.results ?? []
    all.push(...page)
    if (page.length < PAGE_SIZE) break
    skip += PAGE_SIZE
  }
  return all
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Fields that SAP IBP returns on GET but rejects on POST via the *Trans endpoint.
// PlanningAreaID / VersionID are already encoded in the TransactionID context.
// CREATEDDATE / LASTMODIFIEDDATE are server-managed audit fields.
// Exported so the field-mapping analysis can exclude them from the diff.
export const READONLY_FIELDS = new Set([
  'PlanningAreaID', 'VersionID',
  'CREATEDDATE', 'LASTMODIFIEDDATE',
])

function stripReadonlyFields(rows) {
  return rows.map(row => {
    const clean = { ...row }
    READONLY_FIELDS.forEach(k => delete clean[k])
    return clean
  })
}

// Parses business-key field names from an OData entity URI such as
//   .../AS1UOMTO(UOMTOID='2X',PlanningAreaID='ASIBPTS',VersionID='ZPRUEBARED')
// Returns ['UOMTOID', ...], excluding the version-context keys (which travel as
// top-level body fields, not as RequestedAttributes).
const VERSION_CONTEXT_KEYS = new Set(['PlanningAreaID', 'VersionID'])
function parseKeyNames(uri) {
  const m = String(uri || '').match(/\(([^)]*)\)\s*$/)
  if (!m) return []
  return m[1].split(',')
    .map(p => p.split('=')[0].trim())
    .filter(k => k && !VERSION_CONTEXT_KEYS.has(k))
}

function buildFilter(planningArea, versionId) {
  const esc  = v => v.replace(/'/g, "''")  // OData: single quote → doubled
  const parts = []
  if (planningArea) parts.push(`PlanningAreaID eq '${esc(planningArea)}'`)
  if (versionId)    parts.push(`VersionID eq '${esc(versionId)}'`)
  return parts.join(' and ')
}

function stripMeta(row) {
  // eslint-disable-next-line no-unused-vars
  const { __metadata, ...rest } = row
  return rest
}
