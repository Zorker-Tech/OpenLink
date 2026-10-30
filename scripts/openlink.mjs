// Root lifecycle entry point. The implementation remains in dev-browser.mjs
// for backward compatibility with existing local tooling, but all supported
// root commands now enter through this supervisor.
import { readFile } from 'node:fs/promises'

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
