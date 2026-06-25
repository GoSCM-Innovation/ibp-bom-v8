export async function proxyCall({ connection, session, com = '0326', path, method = 'GET', body, injectJobUser, timeout, signal, fetchCsrf, csrf, extractLabels, serviceRoot: serviceRootOverride }) {
  const comKey = `com${com}`
  const agreement = connection[comKey]
  // serviceRootOverride lets callers reuse a com's credentials but target a
  // different OData service (e.g. PLANNING_DATA_API_SRV reuses SAP_COM_0720
  // credentials but a different service URL than MASTER_DATA_API_SRV).
  const serviceRoot = serviceRootOverride || agreement?.url || ''
  const sessionCreds = session?.[comKey] || {}

  let fullPath = path || ''
  if (injectJobUser) {
    const jobUser = connection.jobUser || sessionCreds.user || agreement?.user || ''
    if (jobUser) fullPath += `&JobUser=%27${encodeURIComponent(jobUser)}%27`
  }

  return fetch('/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: serviceRoot + fullPath,
      serviceRoot,
      user: sessionCreds.user || agreement?.user || '',
      password: sessionCreds.password || '',
      method,
      ...(body !== undefined && { body }),
      ...(timeout !== undefined && { timeout }),
      // fetchCsrf: ask the proxy to only obtain a CSRF token+cookies (no real call).
      ...(fetchCsrf ? { fetchCsrf: true } : {}),
      // csrf: reuse a previously obtained { csrfToken, cookies } so the proxy
      // skips the per-POST CSRF round-trip to SAP.
      ...(csrf ? { csrfToken: csrf.csrfToken, cookies: csrf.cookies } : {}),
      // extractLabels: ask the proxy to fetch a (potentially multi-MB) $metadata
      // XML server-side and return ONLY a compact { field: label } map — the huge
      // body never reaches the browser (Vercel's ~4.5 MB response limit).
      ...(extractLabels ? { extractLabels: true } : {}),
    }),
    // Caller-provided AbortSignal lets a cancelled migration cut requests in flight.
    ...(signal ? { signal } : {}),
  })
}
