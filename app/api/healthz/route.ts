import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export function GET() {
  const profile = process.env.OPENLINK_DEPLOYMENT_PROFILE || 'standard'
  const projectRuntime = process.env.OPENLINK_PROJECT_RUNTIME || 'vm'
  return NextResponse.json({
    ok: true,
    releaseId: process.env.OPENLINK_RELEASE_ID || 'development',
    deployment: {
      profile,
      profileRevision: process.env.OPENLINK_DEPLOYMENT_PROFILE_REVISION || `${profile}/v1`,
      projectRuntime,
      isolation: process.env.OPENLINK_PROJECT_ISOLATION || (projectRuntime === 'vm' ? 'vm' : 'container'),
      knowledge: process.env.OPENLINK_KNOWLEDGE_ENABLED !== '0',
      zero: process.env.OPENLINK_ZERO_ENABLED !== '0',
    },
  }, {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  })
}
