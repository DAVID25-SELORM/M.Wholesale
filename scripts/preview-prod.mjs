// Serves a PRODUCTION build locally with the exact security headers of vercel.json (CSP included), against the local dev stack, so you can see what
// the browser will really allow in production: a page that works in `vite dev` can still be blocked by the Content-Security-Policy.
//
//   node scripts/dev-stack.mjs up
//   node scripts/preview-prod.mjs            (builds into dist-preview/, then serves http://127.0.0.1:5290)
//
// Open the app, use it (sign in, PDF downloads, Excel import ...) and watch the browser console for "Refused to ..." CSP messages.
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.PREVIEW_PORT ?? 5290)
const origin = `http://127.0.0.1:${port}`
const out = join(root, 'dist-preview')
const secretsFile = join(root, '.stack', 'secrets.json')
if (!existsSync(secretsFile)) { console.error('Local stack not found. Run: node scripts/dev-stack.mjs up'); process.exit(1) }
const { authUrl, restUrl, anonKey } = JSON.parse(readFileSync(secretsFile, 'utf8'))

if (process.argv.includes('--no-build') === false) {
  console.log('building (production mode) ...')
  const r = spawnSync('npx', ['vite', 'build', '--outDir', 'dist-preview', '--emptyOutDir'], {
    cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, VITE_SUPABASE_URL: origin, VITE_SUPABASE_ANON_KEY: anonKey },
  })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))
const globalHeaders = Object.fromEntries((vercel.headers.find((h) => h.source === '/(.*)')?.headers ?? []).map((h) => [h.key, h.value]))
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.map': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }

function proxy(req, res, target, prefix) {
  const url = new URL(req.url.replace(prefix, '') || '/', target)
  const up = http.request(url, { method: req.method, headers: { ...req.headers, host: url.host } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res) })
  up.on('error', () => { res.writeHead(502); res.end('stack not reachable') })
  req.pipe(up)
}

http.createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0])
  if (path.startsWith('/auth/v1')) return proxy(req, res, authUrl, '/auth/v1')
  if (path.startsWith('/rest/v1')) return proxy(req, res, restUrl, '/rest/v1')
  let file = normalize(join(out, path))
  if (!file.startsWith(out)) { res.writeHead(403); return res.end() }
  const isAsset = path.startsWith('/assets/')
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (isAsset) { res.writeHead(404); return res.end('not found') }
    file = join(out, 'index.html')                       // the same SPA rewrite as vercel.json
  }
  res.writeHead(200, { ...globalHeaders, 'Content-Type': types[extname(file)] ?? 'application/octet-stream', ...(isAsset ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {}) })
  createReadStream(file).pipe(res)
}).listen(port, '127.0.0.1', () => console.log(`production build with production headers on ${origin}`))
