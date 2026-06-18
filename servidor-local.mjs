// Servidor local autocontenido: sirve la interfaz ya compilada (dist/) Y el
// proxy a SAP en un mismo puerto, SIN depender de Vercel ni de su CLI. Reutiliza
// el MISMO api/proxy.js de producción (no hay copia que se desincronice).
//
// Uso:
//   1) npm run build      (genera dist/)
//   2) node servidor-local.mjs
//   3) se abre el navegador en http://localhost:8080
//
// Variables de entorno opcionales: PORT (def. 8080), OPEN=0 (no abrir navegador).
import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exec } from 'node:child_process'
import handler from './api/proxy.js'

const PORT = process.env.PORT || 8080
const DIST = fileURLToPath(new URL('./dist/', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.map':  'application/json',
}

// Adapta la response nativa de Node a la API que espera api/proxy.js
// (res.status().json(), res.send(), y res.setHeader() encadenable).
function makeRes(nodeRes) {
  const res = {
    statusCode: 200,
    setHeader(k, v) { nodeRes.setHeader(k, v); return res },
    status(code) { res.statusCode = code; return res },
    json(obj) { nodeRes.statusCode = res.statusCode; nodeRes.setHeader('Content-Type', 'application/json'); nodeRes.end(JSON.stringify(obj)); return res },
    send(text) { nodeRes.statusCode = res.statusCode; nodeRes.end(text); return res },
    end() { nodeRes.statusCode = res.statusCode; nodeRes.end(); return res },
  }
  return res
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  // --- API: el proxy a SAP corre AQUÍ mismo ---
  if (url.pathname === '/api/proxy') {
    if (req.method === 'POST') req.body = await readBody(req)
    if (req.method === 'POST' || req.method === 'OPTIONS') return handler(req, makeRes(res))
    res.statusCode = 405; return res.end('Method not allowed')
  }

  // --- Estáticos (la interfaz compilada) ---
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end() }

  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'
  let filePath = join(DIST, pathname)

  // Guardia anti path-traversal: el archivo debe quedar dentro de dist/.
  const rel = relative(DIST, filePath)
  if (rel.startsWith('..') || isAbsolute(rel)) { res.statusCode = 403; return res.end('Forbidden') }

  try {
    const s = await stat(filePath)
    if (s.isDirectory()) filePath = join(filePath, 'index.html')
    const data = await readFile(filePath)
    res.setHeader('Content-Type', MIME[extname(filePath).toLowerCase()] || 'application/octet-stream')
    res.statusCode = 200
    return res.end(data)
  } catch {
    // Fallback SPA: cualquier ruta desconocida → index.html (igual que vercel.json).
    try {
      const data = await readFile(join(DIST, 'index.html'))
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.statusCode = 200
      return res.end(data)
    } catch {
      res.statusCode = 404
      return res.end('No se encontro dist/. ¿Ejecutaste "npm run build"?')
    }
  }
})

server.listen(PORT, () => {
  const link = `http://localhost:${PORT}`
  console.log('')
  console.log('  ============================================================')
  console.log('   IBP BOM  -  servidor LOCAL listo')
  console.log(`   Abre:  ${link}`)
  console.log('   (el proxy a SAP corre aqui mismo, sin pasar por Vercel)')
  console.log('   Para detener: cierra esta ventana o pulsa Ctrl+C')
  console.log('  ============================================================')
  console.log('')
  if (process.env.OPEN !== '0') {
    const cmd = process.platform === 'win32' ? `start "" "${link}"`
              : process.platform === 'darwin' ? `open "${link}"`
              : `xdg-open "${link}"`
    exec(cmd, () => {})
  }
})
