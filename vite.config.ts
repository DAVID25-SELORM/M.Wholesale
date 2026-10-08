import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// DEV ONLY: `npm run stack:up` (scripts/dev-stack.mjs) starts a local GoTrue + PostgREST and sets
// VITE_SUPABASE_URL to this dev server, which forwards the two API prefixes. Production builds
// talk to the real Supabase project URL directly and ignore this block.
const authTarget = 'http://127.0.0.1:55330'
const restTarget = 'http://127.0.0.1:55331'

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
  build: { sourcemap: true },
})
