export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url, serviceRoot, user, password, method = 'GET', body } = req.body

  if (!url || !user || !password) return res.status(400).json({ error: 'Missing url, user or password' })

  try { new URL(url) } catch { return res.status(400).json({ error: 'URL inválida' }) }

  try {
    const auth = Buffer.from(`${user}:${password}`).toString('base64')
    const baseHeaders = {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json, application/xml, */*',
      'Content-Type': 'application/json',
    }

    let csrfToken = null
    let sessionCookies = ''
    if (method !== 'GET') {
      const csrfUrl = serviceRoot || url.split('?')[0]
      const csrfResp = await fetch(csrfUrl, { method: 'GET', headers: { ...baseHeaders, 'X-CSRF-Token': 'Fetch' } })
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
    }
    if (body && method !== 'GET') opts.body = JSON.stringify(body)

    const resp = await fetch(url, opts)
    if (!resp.ok) {
      const text = await resp.text()
      return res.status(resp.status).json({ error: `SAP IBP returned ${resp.status}`, detail: text.substring(0, 500) })
    }
    const contentType = resp.headers.get('content-type') || ''
    if (contentType.includes('xml')) {
      return res.setHeader('Content-Type', 'text/xml').send(await resp.text())
    }
    return res.json(await resp.json())
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
