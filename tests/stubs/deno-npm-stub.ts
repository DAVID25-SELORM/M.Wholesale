// Edge Functions import dependencies with Deno's `npm:` scheme, which Vite cannot resolve.
// vitest.config.ts aliases every `npm:` specifier to this file. The import sits inside an
// `if (Deno)` branch that never runs under vitest, so nothing here is ever called.
export function createClient(): never {
  throw new Error('npm: stub - Edge Function entry point must not run under vitest')
}
