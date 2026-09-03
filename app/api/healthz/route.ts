import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json({
    ok: true,
    releaseId: process.env.OPENLINK_RELEASE_ID || 'development',
  }, {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  })
}
