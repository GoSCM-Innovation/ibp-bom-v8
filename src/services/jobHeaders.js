import { proxyCall } from './proxyCall'

// Columns actually consumed by JobMonitor, Resumen, GlobalResumen and StepsPanel.
// Requesting them via $select avoids pulling the full JobHeaderSet row (+ unused
// fields) on every auto-refresh — the single biggest source of background traffic.
export const JOB_HEADER_SELECT = [
  'JobName', 'JobRunCount', 'JobStatus', 'JobText', 'JobTemplateText', 'JobTemplateName',
  'JobCreatedByFormattedName', 'JobCreatedBy', 'JobStepCount',
  'JobPlannedStartDateTime', 'JobStartDateTime', 'JobEndDateTime', 'Periodic',
]

// Builds the JobHeaderSet OData path with $select and, optionally, a date-range
// $filter on JobPlannedStartDateTime.
//
// JobPlannedStartDateTime is an Edm.String in this service (values look like
// "20260611120000.0000000"), so the filter uses plain quoted-string literals and
// the comparison is lexicographic — which, because the format is zero-padded and
// fixed-width, is also chronological. $filter / $orderby on this field are already
// used in production by the orchestration polling (useOrchRun.js), so the mechanism
// is known to work; only the date-range literal is new.
export function buildJobHeaderPath({ fromTs, toTs, withFilter = true }) {
  const params = [`$select=${encodeURIComponent(JOB_HEADER_SELECT.join(','))}`]
  if (withFilter && fromTs && toTs) {
    const f = `JobPlannedStartDateTime ge '${fromTs}' and JobPlannedStartDateTime le '${toTs}'`
    params.push(`$filter=${encodeURIComponent(f)}`)
  }
  return `/JobHeaderSet?${params.join('&')}`
}

// Connections whose tenant rejected the date $filter (HTTP 400). Once a tenant
// rejects it we stop sending the filter for that connection, so we never pay the
// double round-trip again in this session.
const filterRejected = new Set()

// Loads job headers with server-side $select + date $filter.
//
// Empirical safety net: if SAP returns 400 (the field is typed differently on this
// tenant, so the literal is invalid), we remember it and transparently retry once
// WITHOUT the filter — the screen keeps working, just without the bandwidth saving.
// The return value reports `filtered` so callers can surface it in the tech logs.
//
// `caller` is injectable purely so the path/fallback logic can be unit-tested
// without a live backend; production always uses the real proxyCall.
export async function loadJobHeaders({ connection, session, fromTs, toTs, signal, caller = proxyCall }) {
  const key = connection?.id || ''
  const wantFilter = Boolean(fromTs && toTs) && !filterRejected.has(key)

  const run = async (withFilter) => {
    const path = buildJobHeaderPath({ fromTs, toTs, withFilter })
    const start = performance.now()
    const res = await caller({ connection, session, path, signal })
    const data = await res.json()
    return { path, data, status: res.status, ok: res.ok && !data.error, duration: Math.round(performance.now() - start) }
  }

  let r = await run(wantFilter)
  let filtered = wantFilter

  if (!r.ok && filtered && r.status === 400) {
    filterRejected.add(key)
    r = await run(false)
    filtered = false
  }

  const rows = r.data?.d?.results ?? r.data?.value ?? []
  const error = r.data?.error
    ? r.data.error + (r.data.detail ? ': ' + r.data.detail : '')
    : (r.ok ? '' : `HTTP ${r.status}`)
  return { rows, error, status: r.status, path: r.path, duration: r.duration, filtered }
}
