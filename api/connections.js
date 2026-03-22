import crypto from 'crypto'

const REDIS_URL = process.env.KV_REST_API_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN
const KEY = 'ibp:connections'

async function redisGet(key) {
  const resp = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  })
  const data = await resp.json()
  if (!data.result) return []
  const parsed = JSON.parse(data.result)
  return Array.isArray(parsed) ? parsed : []
}

async function redisSet(key, value) {
  await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value))
  })
}

function encrypt(text) {
  const secret = process.env.ENCRYPTION_SECRET || 'default-secret-change-me'
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(secret.padEnd(32).slice(0, 32)), iv)
  return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex')
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: 'Redis no configurado: faltan KV_REST_API_URL o KV_REST_API_TOKEN' })
  }

  try {
    const connections = await redisGet(KEY)

    if (req.method === 'GET') {
      return res.json(connections.map(({ password, ...c }) => c))
    }

    if (req.method === 'POST') {
      const { name, url, user, password } = req.body
      if (!name || !url || !user || !password) return res.status(400).json({ error: 'Faltan campos obligatorios' })
      const newConn = { id: crypto.randomUUID(), name, url, user, password: encrypt(password) }
      connections.push(newConn)
      await redisSet(KEY, connections)
      const { password: _, ...safe } = newConn
      return res.status(201).json(safe)
    }

    const urlParts = req.url.split('/')
    const id = urlParts[urlParts.length - 1]

    if (req.method === 'PUT') {
      const idx = connections.findIndex(c => c.id === id)
      if (idx === -1) return res.status(404).json({ error: 'No encontrado' })
      const { name, url, user, password } = req.body
      connections[idx] = {
        ...connections[idx],
        ...(name && { name }),
        ...(url && { url }),
        ...(user && { user }),
        ...(password && { password: encrypt(password) }),
      }
      await redisSet(KEY, connections)
      const { password: _, ...safe } = connections[idx]
      return res.json(safe)
    }

    if (req.method === 'DELETE') {
      const idx = connections.findIndex(c => c.id === id)
      if (idx === -1) return res.status(404).json({ error: 'No encontrado' })
      connections.splice(idx, 1)
      await redisSet(KEY, connections)
      return res.json({ ok: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: e.message })
  }
}
