// Rehearse backup/restore only against the disposable local test database.
// Never accepts a production URL or a database name supplied by the caller.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { TEST_DB, adminConfig, ensureContainer, waitForDb } from './lib/db.mjs'

if (TEST_DB.database !== 'wps_test' || TEST_DB.host !== '127.0.0.1') throw new Error('Local test database required')
ensureContainer()
await waitForDb()
const scratch = `wps_restore_drill_${randomBytes(6).toString('hex')}`
const controller = new pg.Client(adminConfig())
await controller.connect()
const quote = name => '"' + name.replaceAll('"', '""') + '"'
async function fingerprint(database) {
  const client = new pg.Client(adminConfig(database))
  await client.connect()
  try {
    const tables = await client.query("select schemaname,tablename from pg_tables where schemaname in ('public','private','auth') order by schemaname,tablename")
    const result = []
    for (const { schemaname, tablename } of tables.rows) {
      const table = `${quote(schemaname)}.${quote(tablename)}`
      const data = await client.query(`select count(*)::text count,md5(coalesce(string_agg(row_data,E'\\n' order by row_data),'')) digest from (select to_jsonb(t)::text row_data from ${table} t) rows`)
      result.push({ table, ...data.rows[0] })
    }
    return result
  } finally { await client.end() }
}
try {
  const before = await fingerprint(TEST_DB.database)
  const dump = execFileSync('docker', ['exec', TEST_DB.container, 'pg_dump', '-U', TEST_DB.user, '-Fc', TEST_DB.database], { maxBuffer: 256 * 1024 * 1024 })
  await controller.query(`create database ${quote(scratch)}`)
  execFileSync('docker', ['exec', '-i', TEST_DB.container, 'pg_restore', '-U', TEST_DB.user, '--exit-on-error', '--no-owner', '-d', scratch], { input: dump, maxBuffer: 16 * 1024 * 1024 })
  const restored = await fingerprint(scratch)
  const after = await fingerprint(TEST_DB.database)
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Source changed during the drill; rerun without concurrent tests')
  if (JSON.stringify(before) !== JSON.stringify(restored)) throw new Error('Restored records differ from source')
  console.log(JSON.stringify({ scope: 'local disposable database only', passed: true, tables: restored.length, rows: restored.reduce((sum, table) => sum + Number(table.count), 0), backupBytes: dump.length }, null, 2))
} finally {
  if (!/^wps_restore_drill_[0-9a-f]{12}$/.test(scratch)) throw new Error('Invalid scratch database name')
  await controller.query(`drop database if exists ${quote(scratch)} with (force)`)
  await controller.end()
}
