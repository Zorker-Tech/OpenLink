import { NextResponse } from "next/server";
import { startCloudConnectionLogin } from "@/lib/platform-cloud-login.server";
import { cloudLoginCookie, CloudLoginError } from "@/lib/platform-cloud-login";
import { CloudConnectionError } from "@/lib/platform-cloud-connection.server";

export const runtime = "nodejs";
const headers = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
};
export async function POST(request: Request) {
  try {
    const result = await startCloudConnectionLogin(request);
    const response = NextResponse.json(
      { authorizationUrl: result.authorizationUrl },
      { headers },
    );
    response.cookies.set(cloudLoginCookie, result.cookieValue, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 300,
    });
    return response;
  } catch (error) {
    const known =
      error instanceof CloudLoginError || error instanceof CloudConnectionError;
    return NextResponse.json(
      { error: { code: known ? error.message : "CLOUD_LOGIN_UNAVAILABLE" } },
      { status: known ? error.status : 503, headers },
    );
  }
}
