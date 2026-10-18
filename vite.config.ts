import { readFileSync } from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// DEV ONLY: `npm run stack:up` (scripts/dev-stack.mjs) starts a local GoTrue + PostgREST and sets
// VITE_SUPABASE_URL to this dev server, which forwards the two API prefixes. Production builds
// talk to the real Supabase project URL directly and ignore this block.
// The ports come from the stack's own record, so they follow it if the defaults ever have to change.
const stack = (() => {
  try {
    return JSON.parse(readFileSync(path.resolve(import.meta.dirname, '.stack', 'secrets.json'), 'utf8')) as { authUrl?: string; restUrl?: string }
  } catch {
    return {}
  }
})()
const authTarget = stack.authUrl ?? 'http://127.0.0.1:58330'
const restTarget = stack.restUrl ?? 'http://127.0.0.1:58331'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    proxy: {
      '/auth/v1': { target: authTarget, changeOrigin: true, rewrite: (p) => p.replace(/^\/auth\/v1/, '') },
      '/rest/v1': { target: restTarget, changeOrigin: true, rewrite: (p) => p.replace(/^\/rest\/v1/, '') },
    },
  },
  build: { sourcemap: 'hidden' },
  // the commit this build came from (Vercel sets it), shown next to every reported error
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify((process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev').slice(0, 7)) },
})
