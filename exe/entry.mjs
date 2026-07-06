// Punto de entrada del EJECUTABLE (.exe) autocontenido.
//
// Es la versión "empaquetable" de servidor-local.mjs: en lugar de leer la
// interfaz desde el disco (carpeta dist/), la sirve desde un mapa de archivos
// EMBEBIDO en el propio binario (assets.generated.mjs, creado por build-exe.mjs).
// Así el .exe es un único archivo, sin carpetas sueltas.
//
// Reutiliza el MISMO api/proxy.js de producción (una sola fuente de verdad),
// que build-exe.mjs incrusta con esbuild — no hay copia que se desincronice.
//
// Variables de entorno opcionales: PORT (def. 8080), OPEN=0 (no abrir navegador).
import http from 'node:http'
import { extname } from 'node:path'
import { exec } from 'node:child_process'
import handler from '../api/proxy.js'
import assets from './assets.generated.mjs'   // { '/index.html': '<base64>', ... }

const PORT = process.env.PORT || 8080

// Decodifica una sola vez los archivos embebidos (base64 → Buffer) al arrancar.
const FILES = new Map()
for (const [path, b64] of Object.entries(assets)) FILES.set(path, Buffer.from(b64, 'base64'))

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

  // --- Estáticos (la interfaz compilada, embebida en el binario) ---
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end() }

  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'

  const hit = FILES.get(pathname)
  if (hit) {
    res.setHeader('Content-Type', MIME[extname(pathname).toLowerCase()] || 'application/octet-stream')
    res.statusCode = 200
    return res.end(hit)
  }

  // Fallback SPA: cualquier ruta desconocida → index.html (igual que vercel.json).
  const index = FILES.get('/index.html')
  if (index) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.statusCode = 200
    return res.end(index)
  }
  res.statusCode = 404
  return res.end('No se encontro la interfaz embebida en el ejecutable.')
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  [X] El puerto ${PORT} ya esta en uso.`)
    console.error(`      Quiza el programa ya esta abierto en otra ventana.`)
    console.error(`      Cierra la otra ventana o abre http://localhost:${PORT} en el navegador.\n`)
  } else {
    console.error('\n  [X] Error al iniciar el servidor:', e.message, '\n')
  }
})

server.listen(PORT, () => {
  const link = `http://localhost:${PORT}`
  console.log('')
  console.log('  ============================================================')
  console.log('   IBP BOM  -  Migracion LOCAL (ejecutable)')
  console.log(`   Abre:  ${link}`)
  console.log('   El proxy a SAP corre aqui mismo (sin Vercel, sin topes).')
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
