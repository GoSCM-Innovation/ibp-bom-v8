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

  let { connectionId, path, url, user, password, method = 'GET', body, injectJobUser, com } = req.body
  let serviceRoot = null

  if (connectionId) {
    if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: 'Redis no configurado' })
    const connections = await redisGet(KEY)
    const conn = connections.find(c => c.id === connectionId)
    if (!conn) return res.status(404).json({ error: 'Conexión no encontrada' })

    // com === '0068_taskmon' → usa credenciales de com0068 pero URL de com0068.taskmon
    const isTaskmon = com === '0068_taskmon'
    const agreementKey = (com === '0068' || isTaskmon) ? 'com0068' : 'com0326'
    const agreement = conn[agreementKey]

    if (!agreement?.url || !agreement?.user || !agreement?.password) {
      return res.status(400).json({ error: `SAP_COM_${agreementKey === 'com0068' ? '0068' : '0326'} no configurado para esta conexión` })
    }

    if (isTaskmon) {
      if (!agreement.taskmon?.enabled || !agreement.taskmon?.url) {
        return res.status(400).json({ error: 'Task Monitor no está habilitado para esta conexión' })
      }
      serviceRoot = agreement.taskmon.url
    } else {
      serviceRoot = agreement.url
    }
    user = agreement.user
    password = decrypt(agreement.password)

    if (injectJobUser) {
      const jobUser = conn.jobUser || agreement.user
      path = (path || '') + `&JobUser=%27${encodeURIComponent(jobUser)}%27`
    }
    url = serviceRoot + (path || '')
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
