const ALLOWED_HOST = '.scmibp.ondemand.com'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url, user, password, method = 'GET', body } = req.body

  if (!url || !user || !password) return res.status(400).json({ error: 'Missing url, user or password' })

  // Validate destination host
  try {
    const host = new URL(url).hostname
    if (!host.endsWith(ALLOWED_HOST)) return res.status(403).json({ error: 'Host no permitido' })
  } catch {
    return res.status(400).json({ error: 'URL inválida' })
  }

  try {
    const auth = Buffer.from(`${user}:${password}`).toString('base64')
    const opts = {
      method,
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
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
