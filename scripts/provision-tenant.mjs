import { createClient } from '@supabase/supabase-js'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

const [email, password, firstName, lastName, organizationName] = process.argv.slice(2)
if (!email || !password || !firstName || !lastName || !organizationName) {
  console.error('Usage: node scripts/provision-tenant.mjs <email> <password> <first-name> <last-name> <organization-name>')
  process.exit(2)
}

const supabase = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } })
const { data: userData, error: userError } = await supabase.auth.admin.createUser({ email, password, email_confirm: false })
if (userError) throw userError
const { data: organizationId, error: provisionError } = await supabase.rpc('provision_organization', {
  p_user_id: userData.user.id,
  p_first_name: firstName,
  p_last_name: lastName,
  p_name: organizationName,
})
if (provisionError) {
  await supabase.auth.admin.deleteUser(userData.user.id)
  throw provisionError
}
console.log(JSON.stringify({ organization_id: organizationId, owner_user_id: userData.user.id, email }, null, 2))
