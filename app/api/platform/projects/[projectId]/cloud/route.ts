import { cloudProjectLinksForRequest } from "@/lib/platform-cloud-project.server";
import { CloudProjectLinkError } from "@/lib/platform-cloud-project";
import { CloudConnectionError } from "@/lib/platform-cloud-connection.server";

export const runtime = "nodejs";
const headers = { "cache-control": "private, no-store" };
type Context = { params: Promise<{ projectId: string }> };
function failure(error: unknown) {
  const known =
    error instanceof CloudProjectLinkError ||
    error instanceof CloudConnectionError;
  return Response.json(
    { error: { code: known ? error.message : "CLOUD_PROJECT_UNAVAILABLE" } },
    { status: known ? error.status : 503, headers },
  );
}
function ownedOrigin(request: Request) {
  const origin = new URL(process.env.OPENLINK_APP_URL ?? "");
  if (
    origin.protocol !== "https:" ||
    request.headers.get("origin") !== origin.origin
  )
    throw new CloudProjectLinkError(403, "ORIGIN_NOT_ALLOWED");
}
async function body(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 2048) {
    void request.body?.cancel().catch(() => {});
    throw new CloudProjectLinkError(413, "LINK_REQUEST_TOO_LARGE");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new CloudProjectLinkError(400, "INVALID_LINK_REQUEST");
  let size = 0,
    text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let expire: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    expire = () =>
      reject(new CloudProjectLinkError(408, "LINK_REQUEST_TIMEOUT"));
  });
  void deadline.catch(() => {});
  const timer = setTimeout(expire, 5000);
  if (request.signal.aborted) expire();
  else request.signal.addEventListener("abort", expire, { once: true });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 2048)
        throw new CloudProjectLinkError(413, "LINK_REQUEST_TOO_LARGE");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CloudProjectLinkError) throw error;
    throw new CloudProjectLinkError(400, "INVALID_LINK_REQUEST");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", expire);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function GET(request: Request, context: Context) {
  try {
    const service = await cloudProjectLinksForRequest(),
      { projectId } = await context.params;
    const connectionId = new URL(request.url).searchParams.get("connectionId");
    if (!connectionId) {
      const value = await service.read(projectId);
      return Response.json(
        {
          link: value.link ?? null,
          canManage: value.can_manage,
          executionMigrated: false,
        },
        { headers },
      );
    }
    const result = await service.resolve(projectId, connectionId);
    return Response.json(
      {
        link: result.link,
        cloudProject: result.cloudProject,
        executionMigrated: false,
      },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function PUT(request: Request, context: Context) {
  try {
    ownedOrigin(request);
    const service = await cloudProjectLinksForRequest();
    const value = await body(request);
    if (
      !value ||
      typeof value.connectionId !== "string" ||
      typeof value.platformProjectRef !== "string" ||
      typeof value.revision !== "number"
    )
      throw new CloudProjectLinkError(400, "INVALID_LINK_REQUEST");
    const link = await service.set(
      (await context.params).projectId,
      value.connectionId,
      value.platformProjectRef,
      value.revision,
    );
    return Response.json({ link, executionMigrated: false }, { headers });
  } catch (error) {
    return failure(error);
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    ownedOrigin(request);
    const raw = new URL(request.url).searchParams.get("revision");
    const service = await cloudProjectLinksForRequest();
    await service.remove(
      (await context.params).projectId,
      raw === null ? NaN : Number(raw),
    );
    return new Response(null, { status: 204, headers });
  } catch (error) {
    return failure(error);
  }
}
