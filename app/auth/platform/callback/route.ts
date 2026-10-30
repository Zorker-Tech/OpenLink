import { NextResponse } from "next/server";
import { completeCloudConnectionLogin } from "@/lib/platform-cloud-login.server";
import {
  cloudLoginCookieConfiguration,
  CloudLoginError,
  parseCloudLoginCallback,
} from "@/lib/platform-cloud-login";
import { CloudConnectionError } from "@/lib/platform-cloud-connection.server";
import {
  cloudIdentityLoginOrigin,
  cloudIdentityRequestOrigin,
  cloudIdentityLoginCookieConfiguration,
  completeCloudIdentityLogin,
  hasCloudIdentityLoginCookie,
  matchesCloudIdentityLoginCallback,
} from "@/lib/platform-cloud-auth-login.server";
import { getOpenLinkOrigin, getZorkerOrigin } from "@/lib/cross-app-auth.server";

export const runtime = "nodejs";
const headers = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
};
export async function GET(request: Request) {
  let matchesCloudConnectionLogin = false;
  try {
    parseCloudLoginCallback(request);
    matchesCloudConnectionLogin = true;
  } catch {
    // A callback is classified by its state cookie below, not cookie presence.
  }
  const hasIdentityLoginCookie = hasCloudIdentityLoginCookie(request);
  const matchesIdentityLogin = matchesCloudIdentityLoginCallback(request);

  if (
    matchesIdentityLogin ||
    (hasIdentityLoginCookie && !matchesCloudConnectionLogin)
  ) {
    let response: NextResponse;
    try {
      const result = await completeCloudIdentityLogin(request);
      let destination = new URL(result.nextPath, result.origin);
      if (result.shareSession) {
        try {
          const receiver = new URL("/auth/sso/receive", getZorkerOrigin());
          receiver.searchParams.set(
            "continue_to",
            new URL(result.nextPath, getOpenLinkOrigin()).toString(),
          );
          destination = receiver;
        } catch {
          // A missing Studio peer must not invalidate a valid Cloud login.
        }
      }
      response = NextResponse.redirect(destination, 303);
    } catch {
      let origin: string;
      try {
        origin = cloudIdentityLoginOrigin();
      } catch {
        origin = cloudIdentityRequestOrigin(request);
      }
      response = NextResponse.redirect(
        new URL("/login?error=hydite_auth", origin),
        303,
      );
    }
    for (const [name, value] of Object.entries(headers))
      response.headers.set(name, value);
    const cookie = cloudIdentityLoginCookieConfiguration();
    response.cookies.set(cookie.name, "", {
      httpOnly: true,
      secure: cookie.secure,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return response;
  }

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
  if (matched) {
    const cookie = cloudLoginCookieConfiguration();
    response.cookies.set(cookie.name, "", {
      httpOnly: true,
      secure: cookie.secure,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  }
  return response;
}
