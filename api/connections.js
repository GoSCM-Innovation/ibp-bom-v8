import crypto from 'crypto'

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

async function redisSet(key, value) {
  const resp = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', key, JSON.stringify(value)]])
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    throw new Error(`Redis SET failed (${resp.status}): ${JSON.stringify(data)}`)
  }
}

function encrypt(text) {
  const secret = process.env.ENCRYPTION_SECRET || 'default-secret-change-me'
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(secret.padEnd(32).slice(0, 32)), iv)
  return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex')
}

// Elimina passwords de un acuerdo antes de enviarlo al frontend
function stripPasswords(conn) {
  const { password, ...rest } = conn
  if (rest.com0326) {
    const { password: _, ...c } = rest.com0326
    rest.com0326 = c
  }
  if (rest.com0068) {
    const { password: _, ...c } = rest.com0068
    rest.com0068 = c
  }
  return rest
}

// Encripta un acuerdo de comunicación. existing = acuerdo actual en Redis (para conservar password si no viene nueva)
function encryptAgreement(agreement, existing) {
  if (!agreement) return undefined
  const { url, user, password, taskmon } = agreement
  if (!url && !user) return undefined
  const encryptedPw = password ? encrypt(password) : existing?.password
  const out = { url: url || '', user: user || '', password: encryptedPw || '' }
  // taskmon es un sub-objeto { enabled, url } dentro de com0068 — se preserva si viene, o se mantiene el existente
  if (taskmon !== undefined) {
    if (taskmon && (taskmon.enabled || taskmon.url)) {
      out.taskmon = { enabled: !!taskmon.enabled, url: taskmon.url || '' }
    }
  } else if (existing?.taskmon) {
    out.taskmon = existing.taskmon
  }
  return out
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
      return res.json(connections.map(stripPasswords))
    }

    if (req.method === 'POST') {
      const { name, ambiente, jobUser, logoUrl, com0326, com0068 } = req.body
      if (!name || !ambiente) return res.status(400).json({ error: 'Nombre y ambiente son obligatorios' })

      const enc326 = encryptAgreement(com0326)
      const enc068 = encryptAgreement(com0068)

      const newConn = {
        id: crypto.randomUUID(),
        name,
        ambiente,
        jobUser: jobUser || '',
        logoUrl: logoUrl || '',
        ...(enc326 ? { com0326: enc326 } : {}),
        ...(enc068 ? { com0068: enc068 } : {}),
      }
      connections.push(newConn)
      await redisSet(KEY, connections)
      return res.status(201).json(stripPasswords(newConn))
    }

    const id = req.body?.id
    if (!id) return res.status(400).json({ error: 'Falta id' })

    if (req.method === 'PUT') {
      const idx = connections.findIndex(c => c.id === id)
      if (idx === -1) return res.status(404).json({ error: 'No encontrado' })
      const existing = connections[idx]
      const { name, ambiente, jobUser, logoUrl, com0326, com0068 } = req.body

      const enc326 = 'com0326' in req.body ? encryptAgreement(com0326, existing.com0326) : undefined
      const enc068 = 'com0068' in req.body ? encryptAgreement(com0068, existing.com0068) : undefined

      connections[idx] = {
        ...existing,
        ...(name !== undefined && { name }),
        ...(ambiente !== undefined && { ambiente }),
        ...(jobUser !== undefined && { jobUser }),
        ...(logoUrl !== undefined && { logoUrl }),
        ...('com0326' in req.body && { com0326: enc326 }),
        ...('com0068' in req.body && { com0068: enc068 }),
      }
      // Limpiar acuerdos que quedaron undefined (el usuario los vació)
      if (!connections[idx].com0326) delete connections[idx].com0326
      if (!connections[idx].com0068) delete connections[idx].com0068

      await redisSet(KEY, connections)
      return res.json(stripPasswords(connections[idx]))
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
