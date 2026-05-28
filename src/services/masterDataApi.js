import { proxyCall } from './proxyCall.js'

const COM = '0720'
const VSMT_TTL = 24 * 60 * 60 * 1000  // 24 h

export const PAGE_SIZE    = 2000   // rows per read page  (~4 MB, ~3 s measured)
export const CHUNK_SIZE   = 500    // rows per write POST
export const PARALLEL_R   = 4      // parallel read pages  (3× speedup measured)
export const PARALLEL_W   = 4      // parallel write POSTs

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
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.detail || e.error || resp.status) }
  const data  = await resp.json()
  const rows  = data?.d?.results ?? []

  try { localStorage.setItem(ck, JSON.stringify({ ts: Date.now(), data: rows })) } catch {}
  return rows
}

export function invalidateVsmtCache(connId) {
  try { localStorage.removeItem(`ibp:vsmt:${connId}`) } catch {}
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

// Returns total record count using $inlinecount (no extra $count endpoint needed).
export async function fetchCount(conn, session, name, { planningArea, versionId } = {}) {
  const filter = buildFilter(planningArea, versionId)
  let path = `/${name}?$format=json&$top=0&$inlinecount=allpages`
  if (filter) path += `&$filter=${encodeURIComponent(filter)}`
  const resp = await proxyCall({ connection: conn, session, com: COM, path })
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.detail || e.error || resp.status) }
  const data = await resp.json()
  return parseInt(data?.d?.__count ?? '0', 10)
}

// Fetches one page of rows (2 000 by default). Uses explicit $skip — this tenant
// never returns __next, so the caller drives pagination manually.
export async function readEntityPage(conn, session, name, { skip = 0, top = PAGE_SIZE, planningArea, versionId } = {}) {
  const filter = buildFilter(planningArea, versionId)
  let path = `/${name}?$format=json&$top=${top}&$skip=${skip}`
  if (filter) path += `&$filter=${encodeURIComponent(filter)}`
  const resp = await proxyCall({ connection: conn, session, com: COM, path })
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.detail || e.error || resp.status) }
  const data = await resp.json()
  return (data?.d?.results ?? []).map(stripMeta)
}

// Reads the first `top` rows for preview (used by the Preview button).
export async function previewEntity(conn, session, name, { planningArea, versionId, top = 100 } = {}) {
  return readEntityPage(conn, session, name, { skip: 0, top, planningArea, versionId })
}

// ─── Write ────────────────────────────────────────────────────────────────────

// Step 1: obtain a TransactionID from SAP IBP.
// If versionId is empty/null, omits the filter and IBP defaults to __BASE.
export async function getTransactionId(conn, session, { transactionName, versionId, masterDataTypeId, planningArea }) {
  const encStr = v => `%27${encodeURIComponent(v)}%27`
  const params = [
    `TransactionName=${encStr(transactionName || 'ibp-bom-migration')}`,
    `VersionID=${encStr(versionId || '__BASE')}`,
    `TransactionID=${encStr('')}`,
    `MasterDataTypeID=${encStr(masterDataTypeId)}`,
    `PlanningArea=${encStr(planningArea)}`,
    '$format=json',
  ].join('&')

  // GetTransactionID can take 60+ seconds on some IBP tenants — pass an explicit 90 s timeout.
  const resp = await proxyCall({ connection: conn, session, com: COM, path: `/GetTransactionID?${params}`, timeout: 90000 })
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.detail || e.error || resp.status) }
  const data = await resp.json()
  const txId = data?.d?.Value
  if (!txId) throw new Error('GetTransactionID did not return a TransactionID')
  return txId
}

// Step 2: POST a chunk of rows via deep-insert to <NAME>Trans(id)/Nav<NAME>.
// deleteEntries=true should only be set on the FIRST chunk of a migration run
// to clear existing destination data before loading.
//
// SAP IBP ignores Nav* rows when DeleteEntries=true is set in the same request.
// So when deleteEntries is requested we send TWO calls:
//   1. DeleteEntries=true  + empty Nav* → stages the delete
//   2. DeleteEntries=false + actual rows → stages the insert
export async function postTransChunk(conn, session, name, transactionId, rows, { deleteEntries = false } = {}) {
  const cleanRows = stripReadonlyFields(rows)
  const attrs = cleanRows.length ? Object.keys(cleanRows[0]).join(',') : ''

  if (deleteEntries) {
    // Phase 1: stage delete-only (empty rows)
    const deleteBody = {
      TransactionID:       transactionId,
      DoCommit:            false,
      DeleteEntries:       true,
      RequestedAttributes: attrs,
      [`Nav${name}`]:      { results: [] },
    }
    const delResp = await proxyCall({
      connection: conn, session, com: COM,
      path: `/${name}Trans`, method: 'POST', body: deleteBody,
    })
    if (!delResp.ok) { const e = await delResp.json().catch(() => ({})); throw new Error(e.detail || e.error || delResp.status) }
  }

  // Phase 2: stage the actual rows (always, even after delete)
  const body = {
    TransactionID:       transactionId,
    DoCommit:            false,
    DeleteEntries:       false,
    RequestedAttributes: attrs,
    [`Nav${name}`]:      { results: cleanRows },
  }
  const resp = await proxyCall({
    connection: conn, session, com: COM,
    path: `/${name}Trans`, method: 'POST', body,
  })
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.detail || e.error || resp.status) }
  return resp.json().catch(() => ({}))
}

// Step 3: commit — permanently saves all staged data for this TransactionID.
export async function commitTransaction(conn, session, transactionId) {
  const resp = await proxyCall({
    connection: conn, session, com: COM,
    path: `/Commit?P_TransactionID=%27${encodeURIComponent(transactionId)}%27`,
    method: 'POST',
  })
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.detail || e.error || resp.status) }
  return resp.json().catch(() => ({}))
}

// Step 3b (optional): enable server-side parallel processing for this transaction.
// Call after GetTransactionID and before the first postTransChunk.
// Returns null and does NOT throw when the endpoint is unsupported (HTTP 4xx) so callers
// can treat it as a best-effort optimisation.
export async function initiateParallelProcess(conn, session, transactionId) {
  const resp = await proxyCall({
    connection: conn, session, com: COM,
    path: `/InitiateParallelProcess?P_TransactionID=%27${encodeURIComponent(transactionId)}%27`,
    method: 'POST',
  })
  if (!resp.ok) {
    if (resp.status >= 400 && resp.status < 500) return null
    const e = await resp.json().catch(() => ({})); throw new Error(e.detail || e.error || resp.status)
  }
  return resp.json().catch(() => ({}))
}

// Step 3c (optional): retrieve aggregate import result (TotalCount, SuccessCount, ErrorCount).
// Returns null when the endpoint is not available (4xx) so callers can fall back to readMessages.
export async function getExportResult(conn, session, transactionId) {
  const resp = await proxyCall({
    connection: conn, session, com: COM,
    path: `/GetExportResult?P_TransactionID=%27${encodeURIComponent(transactionId)}%27`,
  })
  if (!resp.ok) {
    if (resp.status >= 400 && resp.status < 500) return null
    const e = await resp.json().catch(() => ({})); throw new Error(e.detail || e.error || resp.status)
  }
  const data = await resp.json().catch(() => ({}))
  return data?.d ?? null
}

// Step 4: read per-row error/info messages after commit.
export async function readMessages(conn, session, name, transactionId) {
  const filter = `TransactionID eq %27${encodeURIComponent(transactionId)}%27`
  const path   = `/${name}Message?$format=json&$filter=${filter}`
  const resp   = await proxyCall({ connection: conn, session, com: COM, path })
  if (!resp.ok) return []
  const data = await resp.json().catch(() => ({}))
  return data?.d?.results ?? []
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Fields that SAP IBP returns on GET but rejects on POST via the *Trans endpoint.
// PlanningAreaID / VersionID are already encoded in the TransactionID context.
// CREATEDDATE / LASTMODIFIEDDATE are server-managed audit fields.
const READONLY_FIELDS = new Set([
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
