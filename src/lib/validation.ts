import { z } from 'zod'

// Mirrors the database check constraints (entity_code domain etc.). The database
// remains the authority; this only gives instant, friendly feedback.
export const entityCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/, 'Use 1–32 letters, numbers, "-" or "_" (no spaces).')

export const requiredText = (label: string, max = 200) =>
  z.string().trim().min(1, `${label} is required`).max(max, `${label} is too long`)

export const optionalText = (max = 500) =>
  z.string().trim().max(max, 'Too long').optional().transform((v) => (v ? v : undefined))

export type FieldErrors<T> = Partial<Record<keyof T & string, string>>

/** Validate form values; returns data or a map of field -> first error message. */
export function validate<S extends z.ZodTypeAny>(
  schema: S,
  values: unknown,
): { ok: true; data: z.output<S> } | { ok: false; errors: Record<string, string> } {
  const r = schema.safeParse(values)
  if (r.success) return { ok: true, data: r.data }
  const errors: Record<string, string> = {}
  for (const issue of r.error.issues) {
    const key = String(issue.path[0] ?? '_form')
    if (!(key in errors)) errors[key] = issue.message
  }
  return { ok: false, errors }
}
