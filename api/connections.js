import { Redis } from '@upstash/redis'
import crypto from 'crypto'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

const KEY = 'ibp:connections'

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

async function getAll() {
  const data = await redis.get(KEY)
  return data || []
}

async function saveAll(connections) {
  await redis.set(KEY, connections)
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    const connections = await getAll()

    if (req.method === 'GET') {
      // Return connections without password
      return res.json(connections.map(({ password, ...c }) => c))
    }

    if (req.method === 'POST') {
      const { name, url, user, password } = req.body
      if (!name || !url || !user || !password) return res.status(400).json({ error: 'Faltan campos obligatorios' })
      const newConn = { id: crypto.randomUUID(), name, url, user, password: encrypt(password) }
      connections.push(newConn)
      await saveAll(connections)
      const { password: _, ...safe } = newConn
      return res.status(201).json(safe)
    }

    // Extract id from URL path for PUT and DELETE
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
      await saveAll(connections)
      const { password: _, ...safe } = connections[idx]
      return res.json(safe)
    }

    if (req.method === 'DELETE') {
      const idx = connections.findIndex(c => c.id === id)
      if (idx === -1) return res.status(404).json({ error: 'No encontrado' })
      connections.splice(idx, 1)
      await saveAll(connections)
      return res.json({ ok: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: e.message })
  }
}
