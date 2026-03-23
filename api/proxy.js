import crypto from 'crypto'

const ALLOWED_HOST = '.scmibp.ondemand.com'
const REDIS_URL = process.env.KV_REST_API_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN
const KEY = 'ibp:connections'

async function redisGet(key) {
  const resp = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['GET', key]])
  })
  const data = await resp.json()
  const result = data[0]?.result
  if (!result) return []
  try {
    const parsed = JSON.parse(result)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function decrypt(text) {
  try {
    const secret = process.env.ENCRYPTION_SECRET || 'default-secret-change-me'
    const [ivHex, encrypted] = text.split(':')
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(secret.padEnd(32).slice(0, 32)), Buffer.from(ivHex, 'hex'))
    return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8')
  } catch { return '' }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let { connectionId, path, url, user, password, method = 'GET', body } = req.body
  let serviceRoot = null

  // Mode: connectionId + path → resolve credentials from Redis
  if (connectionId) {
    if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: 'Redis no configurado' })
    const connections = await redisGet(KEY)
    const conn = connections.find(c => c.id === connectionId)
    if (!conn) return res.status(404).json({ error: 'Conexión no encontrada' })
    serviceRoot = conn.url
    url = conn.url + (path || '')
    user = conn.user
    password = decrypt(conn.password)
  }

  if (!url || !user || !password) return res.status(400).json({ error: 'Missing url, user or password' })

  try {
    const host = new URL(url).hostname
    if (!host.endsWith(ALLOWED_HOST)) return res.status(403).json({ error: 'Host no permitido' })
  } catch {
    return res.status(400).json({ error: 'URL inválida' })
  }

  try {
    const auth = Buffer.from(`${user}:${password}`).toString('base64')
    const baseHeaders = { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json, application/xml, */*', 'Content-Type': 'application/json' }
    const diag = []

    // For POST/PUT/DELETE: fetch CSRF token first from service root
    let csrfToken = null
    if (method !== 'GET') {
      const csrfUrl = serviceRoot || url.split('?')[0]
      const csrfReqHeaders = { ...baseHeaders, 'X-CSRF-Token': 'Fetch' }
      const csrfResp = await fetch(csrfUrl, { method: 'GET', headers: csrfReqHeaders })
      const csrfRespHeaders = Object.fromEntries(csrfResp.headers.entries())
      csrfToken = csrfResp.headers.get('x-csrf-token')
      diag.push({
        step: '1 — CSRF Token Fetch',
        request: { method: 'GET', url: csrfUrl, headers: { ...csrfReqHeaders, Authorization: '[REDACTED]' } },
        response: { status: csrfResp.status, headers: csrfRespHeaders, csrfToken: csrfToken || 'NO ENCONTRADO' },
      })
    }

    const reqHeaders = { ...baseHeaders, ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) }
    const opts = { method, headers: reqHeaders }
    if (body && method !== 'GET') opts.body = JSON.stringify(body)

    diag.push({
      step: `2 — Petición principal (${method})`,
      request: { method, url, headers: { ...reqHeaders, Authorization: '[REDACTED]' }, body: body || null },
    })

    const resp = await fetch(url, opts)
    const respHeaders = Object.fromEntries(resp.headers.entries())
    const respText = await resp.text()

    diag[diag.length - 1].response = { status: resp.status, headers: respHeaders, body: respText.substring(0, 1000) }

    if (!resp.ok) {
      return res.status(resp.status).json({ error: `SAP IBP returned ${resp.status}`, detail: respText.substring(0, 500), diag })
    }

    const contentType = resp.headers.get('content-type') || ''
    if (contentType.includes('xml')) {
      return res.setHeader('Content-Type', 'application/json').json({ _xml: respText, diag })
    }
    try {
      return res.json({ ...JSON.parse(respText), diag })
    } catch {
      return res.json({ _raw: respText, diag })
    }
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
