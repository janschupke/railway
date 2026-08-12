import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";

export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/", request.url), {
    // 303 so the browser follows with GET after the POST.
    status: 303,
  });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
