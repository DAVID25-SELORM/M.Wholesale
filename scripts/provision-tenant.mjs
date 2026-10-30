import { createClient } from '@supabase/supabase-js'
import { readFile } from 'node:fs/promises'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

const [command, file] = process.argv.slice(2)
if (!['create', 'list'].includes(command) || (command === 'create' && !file)) {
  console.error('Usage: node scripts/provision-tenant.mjs create <onboarding.json> | list')
  process.exit(2)
}

const supabase = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } })
try {
  if (command === 'list') {
    let offset = 0
    while (true) {
      const { data, error } = await supabase.from('organizations').select('id,name,is_active,currency_code,country,created_at').order('created_at').order('id').range(offset, offset + 99)
      if (error) throw error
      for (const row of data) console.log(JSON.stringify(row))
      if (data.length < 100) break
      offset += 100
    }
  } else {
    const input = JSON.parse(await readFile(file, 'utf8'))
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (!uuid.test(input.request_id ?? '') || !uuid.test(input.owner_user_id ?? '')) throw new Error('Provide valid request_id and owner_user_id UUIDs.')
    if (['first_name', 'last_name', 'organization_name'].some(k => typeof input[k] !== 'string' || !input[k].trim())) throw new Error('Owner names and organization_name are required.')
    const { data: owner, error: ownerError } = await supabase.auth.admin.getUserById(input.owner_user_id)
    if (ownerError) throw ownerError
    if (!owner.user?.email_confirmed_at) throw new Error('Owner must finish email verification before onboarding.')
    const { data, error } = await supabase.rpc('onboard_tenant', {
      p_request_id: input.request_id, p_owner_user_id: input.owner_user_id,
      p_first_name: input.first_name, p_last_name: input.last_name, p_name: input.organization_name,
      p_currency: input.currency ?? 'GHS', p_timezone: input.timezone ?? 'Africa/Accra', p_country: input.country ?? 'GH',
    })
    if (error) throw error
    console.log(JSON.stringify({ organization_id: data, owner_user_id: input.owner_user_id, request_id: input.request_id }, null, 2))
  }
} catch (error) {
  console.error(error.message ?? 'Tenant operation failed.')
  console.error('No authentication accounts were deleted. Retry creation with the SAME request ID and details after resolving the error.')
  process.exitCode = 1
}
