export const HOST_BUNDLE_BUCKET = "public-slate-host-bundle"
export const HOST_BUNDLE_REGION = "us-east-1"
export const HOST_BUNDLE_PREFIX = "slate-host-bundle"
export const DEFAULT_BASE_URL = `https://${HOST_BUNDLE_BUCKET}.s3.${HOST_BUNDLE_REGION}.amazonaws.com/${HOST_BUNDLE_PREFIX}`
export const LATEST_VERSION_FILE = "slate-host-bundle-latest.version"

export function hostBundleBaseUrl(): string {
  const override = process.env.SLATE_HOST_BUNDLE_S3_BASE_URL?.trim()
  return override !== undefined && override.length > 0
    ? override.replace(/\/+$/, "")
    : DEFAULT_BASE_URL
}

export function latestHostBundleVersionUrl(base = hostBundleBaseUrl()): string {
  return `${base}/${LATEST_VERSION_FILE}`
}

export function hostBundleTarballUrl(version: string, base = hostBundleBaseUrl()): string {
  return `${base}/${HOST_BUNDLE_PREFIX}-${version}.tgz`
}
