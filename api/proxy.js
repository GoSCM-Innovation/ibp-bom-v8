export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const {
    url, serviceRoot, user, password, method = 'GET', body, timeout = 30000,
    fetchCsrf, csrfToken: providedToken, cookies: providedCookies,
  } = req.body

  if (!user || !password) return res.status(400).json({ error: 'Missing user or password' })

  try {
    const auth = Buffer.from(`${user}:${password}`).toString('base64')
    const baseHeaders = {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json, application/xml, */*',
      'Content-Type': 'application/json',
    }

    // Mode: only obtain a CSRF token + cookies (reused by the caller across POSTs).
    if (fetchCsrf) {
      const csrfUrl = serviceRoot
      if (!csrfUrl) return res.status(400).json({ error: 'Missing serviceRoot' })
      try { new URL(csrfUrl) } catch { return res.status(400).json({ error: 'URL inválida' }) }
      const r = await fetch(csrfUrl, {
        method: 'GET',
        headers: { ...baseHeaders, 'X-CSRF-Token': 'Fetch' },
        signal: AbortSignal.timeout(90000),
      })
      const token   = r.headers.get('x-csrf-token')
      const cookies = (r.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
      return res.json({ csrfToken: token, cookies })
    }

    if (!url) return res.status(400).json({ error: 'Missing url' })
    try { new URL(url) } catch { return res.status(400).json({ error: 'URL inválida' }) }

    let csrfToken = providedToken || null
    let sessionCookies = providedCookies || ''
    // Fetch CSRF only when a non-GET call didn't bring a reusable token.
    if (method !== 'GET' && !csrfToken) {
      const csrfUrl = serviceRoot || url.split('?')[0]
      const csrfResp = await fetch(csrfUrl, {
        method: 'GET',
        headers: { ...baseHeaders, 'X-CSRF-Token': 'Fetch' },
        // CSRF fetch: some IBP tenants take 60+ s on the first POST after a heavy operation.
        signal: AbortSignal.timeout(90000),
      })
      csrfToken = csrfResp.headers.get('x-csrf-token')
      const setCookies = csrfResp.headers.getSetCookie?.() ?? []
      if (setCookies.length > 0) {
        sessionCookies = setCookies.map(c => c.split(';')[0]).join('; ')
      }
    }

    const opts = {
      method,
      headers: {
        ...baseHeaders,
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        ...(sessionCookies ? { 'Cookie': sessionCookies } : {}),
      },
      signal: AbortSignal.timeout(timeout),
    }
    if (body && method !== 'GET') opts.body = JSON.stringify(body)

    const resp = await fetch(url, opts)
    if (!resp.ok) {
      const text = await resp.text()
      // Intentar extraer mensaje legible del cuerpo (JSON o XML de OData)
      let detail = text.substring(0, 800)
      try {
        const j = JSON.parse(text)
        // SAP can return message as a plain string OR as { lang, value }
        const rawMsg = j?.error?.message
        const msg = typeof rawMsg === 'string' ? rawMsg : (rawMsg?.value ?? null)
        const code = j?.error?.code
        if (msg != null) detail = String(code ? `[${code}] ${msg}` : msg)
      } catch {
        // XML: extraer <code> y <message>
        const code = text.match(/<code>([^<]*)<\/code>/)?.[1]
        const msg  = text.match(/<message[^>]*>([^<]*)<\/message>/)?.[1]
        if (msg) detail = code ? `[${code}] ${msg}` : msg
      }
      return res.status(resp.status).json({ error: `SAP IBP returned ${resp.status}`, detail })
    }
    const contentType = resp.headers.get('content-type') || ''
    const text = await resp.text()

    // Truncation guard. Large OData responses relayed through this serverless
    // function were observed to arrive INCOMPLETE under load (the body ends mid
    // string). Two checks catch it; either way we surface a RETRYABLE 502 so the
    // caller re-reads the page (reads are idempotent) instead of letting a
    // partial body through — which used to throw "Unterminated string in JSON"
    // and return an opaque 500 that failed the whole table.
    //   1) Declared Content-Length vs bytes actually received. (When SAP gzips,
    //      received > declared, so this never false-positives.)
    //   2) The body must parse as JSON before we forward it.
    const declared = parseInt(resp.headers.get('content-length') || '0', 10)
    const received = Buffer.byteLength(text)
    if (declared && received < declared) {
      return res.status(502).json({
        error: 'Respuesta incompleta de SAP IBP',
        detail: `Cuerpo truncado: se recibieron ${received} de ${declared} bytes`,
      })
    }

    if (contentType.includes('xml')) {
      return res.setHeader('Content-Type', 'text/xml').send(text)
    }

    // A genuinely EMPTY 2xx body (e.g. 204-style commits) is fine — don't confuse
    // it with a truncated response. Forward it as an empty JSON object.
    if (text.length === 0) {
      return res.setHeader('Content-Type', 'application/json').send('{}')
    }

    try {
      JSON.parse(text)
    } catch (parseErr) {
      return res.status(502).json({
        error: 'Respuesta incompleta de SAP IBP',
        detail: `JSON inválido o truncado: ${parseErr.message}`,
      })
    }
    // Forward the validated body verbatim (no re-serialize → faster, byte-exact).
    return res.setHeader('Content-Type', 'application/json').send(text)
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
