export {
  DELETE,
  GET,
  HEAD,
  OPTIONS,
  PATCH,
  POST,
  PUT,
} from '../_openlink/studio/[[...path]]/route'

// Route segment configuration must be declared in the route module itself for
// Next.js static analysis; re-exporting it causes production builds to fail.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
