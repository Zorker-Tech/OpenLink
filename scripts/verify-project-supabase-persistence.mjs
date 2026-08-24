#!/usr/bin/env node
import assert from 'node:assert/strict'

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const url = required('OPENLINK_PROJECT_SUPABASE_URL').replace(/\/$/, '')
const serviceKey = required('OPENLINK_PROJECT_SUPABASE_SERVICE_KEY')
const databaseUrl = required('OPENLINK_PROJECT_SUPABASE_DATABASE_URL')
const marker = required('OPENLINK_PROJECT_SUPABASE_PERSISTENCE_MARKER')
const bucket = marker.slice(0, 48)
const expected = `OpenLink Project Supabase ${marker}`
const { default: postgres } = await import('postgres')
const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, idle_timeout: 5 })

try {
  const rows = await sql`select marker from public.openlink_e2e_items where marker = ${marker}`
  assert.equal(rows[0]?.marker, marker, 'Postgres fixture did not survive the guest reboot')

  const response = await fetch(`${url}/storage/v1/object/authenticated/${bucket}/persistence.txt`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    signal: AbortSignal.timeout(30_000),
  })
  assert.ok(response.ok, `Storage persistence download returned ${response.status}`)
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), expected, 'Storage fixture did not survive the guest reboot')
  process.stdout.write(`${JSON.stringify({ ok: true, marker, postgres: true, storage: true })}\n`)
} finally {
  await sql.end({ timeout: 5 })
}
