import { NextResponse } from "next/server";
import {
  beginCloudIdentityLogin,
  cloudIdentityLoginCookieConfiguration,
  cloudIdentityLoginOrigin,
  cloudIdentityRequestOrigin,
} from "@/lib/platform-cloud-auth-login.server";

export const runtime = "nodejs";
const headers = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
};

export async function GET(request: Request) {
  let response: NextResponse;
  try {
    const login = await beginCloudIdentityLogin(request);
    response = NextResponse.redirect(login.authorizationUrl, 303);
    const cookie = cloudIdentityLoginCookieConfiguration();
    response.cookies.set(cookie.name, login.cookieValue, {
      httpOnly: true,
      secure: cookie.secure,
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60,
    });
  } catch {
    let origin: string;
    try {
      origin = cloudIdentityLoginOrigin();
    } catch {
      origin = cloudIdentityRequestOrigin(request);
    }
    const destination = new URL(
      "/login?error=hydite_auth",
      origin,
    );
    response = NextResponse.redirect(destination, 303);
  }
  for (const [name, value] of Object.entries(headers))
    response.headers.set(name, value);
  return response;
}
