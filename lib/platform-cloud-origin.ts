function parseOrigin(value: string) {
  const origin = new URL(value.trim());
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("invalid Cloud app origin");
  return origin;
}

export function isCloudDevelopmentHttpOriginAllowed() {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.OPENLINK_RUNTIME_MODE !== "cloud"
  )
    return false;

  try {
    const appOrigin = parseOrigin(process.env.OPENLINK_APP_URL ?? "");
    const explicitOrigin = parseOrigin(
      process.env.OPENLINK_CLOUD_INSECURE_HTTP_ORIGIN ?? "",
    );
    return (
      appOrigin.protocol === "http:" &&
      explicitOrigin.protocol === "http:" &&
      appOrigin.origin === explicitOrigin.origin
    );
  } catch {
    return false;
  }
}

export function configuredCloudAppOrigin() {
  const origin = parseOrigin(process.env.OPENLINK_APP_URL ?? "");
  if (
    origin.protocol !== "https:" &&
    !isCloudDevelopmentHttpOriginAllowed()
  )
    throw new Error("Cloud app origin must use HTTPS");
  return origin;
}
