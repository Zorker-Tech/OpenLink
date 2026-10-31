// Root lifecycle entry point. The implementation remains in dev-browser.mjs
// for backward compatibility with existing local tooling, but all supported
// root commands now enter through this supervisor.
import { readFile } from 'node:fs/promises'

let architecture
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index]
  if (argument === '-e1' || argument === '--e1' || argument === '--arch=e1' || argument === '--architecture=e1') {
    architecture = 'e1'
    continue
  }
  if (argument === '-t1' || argument === '--t1' || argument === '--arch=t1' || argument === '--architecture=t1') {
    architecture = 't1'
    continue
  }
  if (argument === '--arch' || argument === '--architecture') {
    const value = process.argv[index + 1]?.trim().toLowerCase()
    if (value !== 't1' && value !== 'e1') throw new Error('OpenLink architecture must be t1 or e1')
    architecture = value
    index += 1
  }
}
architecture ||= process.env.OPENLINK_ARCHITECTURE?.trim().toLowerCase() || 't1'
if (architecture !== 't1' && architecture !== 'e1') throw new Error('OpenLink architecture must be t1 or e1')
// T1 is the default product architecture. E1 is the explicit heavier-isolation
// mode invoked with -e1; it keeps the per-session container desktop.
process.env.OPENLINK_ARCHITECTURE = architecture

const profileIndex = process.argv.indexOf('--profile')
if (profileIndex !== -1) {
  const profile = process.argv[profileIndex + 1]?.trim().toLowerCase()
  if (profile !== 'local' && profile !== 'cloud') {
    throw new Error('OpenLink runtime profile must be local or cloud')
  }

  // Resolve the profile before importing the supervisor: it reads runtime
  // mode while its module initializes and starts mode-specific services.
  process.env.OPENLINK_RUNTIME_MODE = profile
  process.env.NEXT_PUBLIC_OPENLINK_RUNTIME_MODE = profile

  if (profile === 'cloud') {
    const cloudUrl = process.env.OPENLINK_CLOUD_SUPABASE_URL?.trim()
    const cloudKey = process.env.OPENLINK_CLOUD_SUPABASE_PUBLISHABLE_KEY?.trim()
    if (!cloudUrl || !cloudKey) {
      throw new Error(
        'Cloud profile requires OPENLINK_CLOUD_SUPABASE_URL and OPENLINK_CLOUD_SUPABASE_PUBLISHABLE_KEY in .env.cloud',
      )
    }

    // The Cloud server and browser must use the same hosted project. These
    // public aliases support existing Next.js client/server call sites.
    process.env.NEXT_PUBLIC_SUPABASE_URL = cloudUrl
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = cloudKey

    // Next loads its standard .env* files after this entry point. Seed any
    // otherwise-undefined values from those files with an empty environment
    // value so .env.local cannot silently add Local endpoints or credentials
    // to a Cloud process. Values from the shell and .env.cloud stay intact.
    for (const fileName of [
      '.env.development.local',
      '.env.local',
      '.env.development',
      '.env.production.local',
      '.env.production',
      '.env',
    ]) {
      let contents
      try {
        contents = await readFile(new URL(`../${fileName}`, import.meta.url), 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      for (const match of contents.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm)) {
        if (process.env[match[1]] === undefined) process.env[match[1]] = ''
      }
    }
  }
}

await import('./dev-browser.mjs')
