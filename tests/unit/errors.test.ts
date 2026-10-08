import { describe, expect, it } from 'vitest'
import { AppError, toAppError } from '@/lib/errors'

describe('toAppError', () => {
  it('maps database error codes to friendly kinds and messages', () => {
    expect(toAppError({ code: '23505', message: 'duplicate key value violates unique constraint "branches_org_code_key"' }))
      .toMatchObject({ kind: 'duplicate', message: expect.stringMatching(/already in use/i) })
    expect(toAppError({ code: '42501', message: 'new row violates row-level security policy for table "branches"' }))
      .toMatchObject({ kind: 'permission', message: 'You do not have permission to do that.' })
    expect(toAppError({ code: '23503', message: 'violates foreign key constraint' })).toMatchObject({ kind: 'reference' })
    expect(toAppError({ code: 'PGRST301', message: 'JWT expired' })).toMatchObject({ kind: 'auth' })
    expect(toAppError({ code: 'PGRST116', message: 'no rows' })).toMatchObject({ kind: 'not_found' })
  })

  it('keeps our own RAISE EXCEPTION sentences but hides SQL jargon', () => {
    expect(toAppError({ code: '42501', message: 'cannot assign a role with permissions you do not hold' }).message)
      .toBe('cannot assign a role with permissions you do not hold')
    expect(toAppError({ code: '23514', message: 'new row for relation "branches" violates check constraint "branches_name_check"' }).message)
      .toBe('Some values are not valid. Please review the form.')
  })

  it('detects network failures and passes AppError through unchanged', () => {
    expect(toAppError(new TypeError('Failed to fetch'))).toMatchObject({ kind: 'network' })
    const e = new AppError('unknown', 'x')
    expect(toAppError(e)).toBe(e)
  })

  it('never throws on junk input', () => {
    for (const junk of [null, undefined, 42, 'text', {}]) expect(toAppError(junk)).toBeInstanceOf(AppError)
  })
})
