// Empaqueta la app en un ÚNICO ejecutable de Windows (IBP-Migracion.exe) que NO
// necesita Node instalado en la maquina de destino. Usa la funcion oficial "SEA"
// (Single Executable Applications) de Node.
//
// Uso:   npm run build:exe
//
// Que hace, en orden:
//   1. Compila la interfaz  (npm run build  →  dist/)
//   2. Embebe todos los archivos de dist/ en un modulo JS (base64)
//   3. Junta servidor + proxy + interfaz en un solo archivo CJS  (esbuild)
//   4. Genera el "blob" SEA y lo inyecta en una copia de node.exe (postject)
//   5. Deja  IBP-Migracion.exe  en la raiz del proyecto
//
// Requisitos: Node >= 20 (probado en 24), Windows x64. El .exe resultante hereda
// la arquitectura del node.exe de esta maquina.
import { execFileSync } from 'node:child_process'
import {
  readFileSync, writeFileSync, readdirSync, statSync,
  copyFileSync, mkdirSync, rmSync, existsSync,
} from 'node:fs'
import { join, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import { inject } from 'postject'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const DIST = join(ROOT, 'dist')
const EXE_DIR = join(ROOT, 'exe')
const TMP = join(ROOT, '.exe-build')
const OUT = join(ROOT, 'IBP-Migracion.exe')
const ASSETS_MOD = join(EXE_DIR, 'assets.generated.mjs')
const BUNDLE = join(TMP, 'bundle.cjs')
const BLOB = join(TMP, 'sea-prep.blob')
const SEA_CONFIG = join(TMP, 'sea-config.json')
// Sentinela estandar de Node para SEA (identico en la doc oficial).
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

const step = (n, msg) => console.log(`\n[${n}/5] ${msg}`)
const mb = bytes => (bytes / 1048576).toFixed(1) + ' MB'

// Recorre dist/ y devuelve { '/ruta/web': Buffer } para cada archivo.
function collectDist(dir, base = dir, out = {}) {
  for (const name of readdirSync(dir)) {
    if (name === 'desktop.ini') continue   // artefacto de Windows/OneDrive, no sirve
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) { collectDist(full, base, out); continue }
    const webPath = '/' + relative(base, full).split(/[\\/]/).join('/')
    out[webPath] = readFileSync(full)
  }
  return out
}

async function main() {
  console.log('==============================================')
  console.log('  Empaquetando IBP-Migracion.exe')
  console.log('==============================================')

  // 1) Compilar la interfaz.
  step(1, 'Compilando la interfaz (npm run build)...')
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit', cwd: ROOT, shell: true })
  if (!existsSync(DIST)) throw new Error('No se genero dist/. Revisa el paso de build.')

  // 2) Embeber dist/ como modulo base64.
  step(2, 'Embebiendo la interfaz en el binario...')
  const files = collectDist(DIST)
  const asBase64 = {}
  let total = 0
  for (const [p, buf] of Object.entries(files)) { asBase64[p] = buf.toString('base64'); total += buf.length }
  writeFileSync(ASSETS_MOD, `// Generado por build-exe.mjs — NO editar a mano.\nexport default ${JSON.stringify(asBase64)}\n`)
  console.log(`      ${Object.keys(files).length} archivos, ${mb(total)} de interfaz.`)

  // 3) Bundle unico (servidor + proxy + interfaz) en CJS — requisito de SEA.
  step(3, 'Juntando todo en un solo archivo (esbuild)...')
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  await esbuild({
    entryPoints: [join(EXE_DIR, 'entry.mjs')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: BUNDLE,
    minify: true,
    legalComments: 'none',
  })
  console.log(`      bundle: ${mb(statSync(BUNDLE).size)}`)

  // 4) Generar el blob SEA e inyectarlo en una copia de node.exe.
  step(4, 'Generando el ejecutable (SEA + postject)...')
  writeFileSync(SEA_CONFIG, JSON.stringify({
    main: BUNDLE,
    output: BLOB,
    disableExperimentalSEAWarning: true,
  }, null, 2))
  execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONFIG], { stdio: 'inherit', cwd: ROOT })

  if (existsSync(OUT)) rmSync(OUT)
  copyFileSync(process.execPath, OUT)              // copia de node.exe = base del ejecutable
  await inject(OUT, 'NODE_SEA_BLOB', readFileSync(BLOB), { sentinelFuse: FUSE })

  // 5) Listo.
  step(5, 'Listo.')
  console.log('\n==============================================')
  console.log(`  OK  ->  ${OUT}`)
  console.log(`  Tamano: ${mb(statSync(OUT).size)}`)
  console.log('==============================================')
  console.log('\n  Enviaselo a tu colega. Doble clic y listo (Windows 64 bits).')
  console.log('  La 1a vez Windows puede pedir "Mas informacion -> Ejecutar de todas formas".\n')
}

main().catch(err => {
  console.error('\n[X] Fallo el empaquetado:\n', err?.message || err, '\n')
  process.exit(1)
})
