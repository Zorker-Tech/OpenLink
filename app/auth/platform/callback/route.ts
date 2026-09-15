import { NextResponse } from "next/server";
import { completeCloudConnectionLogin } from "@/lib/platform-cloud-login.server";
import {
  cloudLoginCookie,
  CloudLoginError,
  parseCloudLoginCallback,
} from "@/lib/platform-cloud-login";
import { CloudConnectionError } from "@/lib/platform-cloud-connection.server";

export const runtime = "nodejs";
const headers = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
};
export async function GET(request: Request) {
  let matched = false;
  let response: NextResponse;
  try {
    parseCloudLoginCallback(request);
    matched = true;
    const result = await completeCloudConnectionLogin(request);
    response = NextResponse.redirect(result.destination, 303);
  } catch (error) {
    const known =
      error instanceof CloudLoginError || error instanceof CloudConnectionError;
    response = NextResponse.json(
      { error: { code: known ? error.message : "CLOUD_LOGIN_UNAVAILABLE" } },
      { status: known ? error.status : 503 },
    );
  }
  for (const [name, value] of Object.entries(headers))
    response.headers.set(name, value);
  if (matched)
    response.cookies.set(cloudLoginCookie, "", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  return response;
}
