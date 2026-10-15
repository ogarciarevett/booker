import { type NextRequest, NextResponse } from "next/server";
import { dashboardPort, guardRequest } from "./lib/request-guard.ts";

/**
 * Runs before every request, assets included (no matcher): anything not addressed to this
 * dashboard's loopback origin is answered here, with no data, before a page or route can read
 * Booker. See lib/request-guard.ts and docs/observability.md#dashboard.
 */
export function proxy(request: NextRequest): NextResponse {
  const verdict = guardRequest(
    { method: request.method, pathname: request.nextUrl.pathname, headers: request.headers },
    dashboardPort(process.env),
  );
  if (!verdict.allowed) {
    return new NextResponse(verdict.reason, {
      status: verdict.status,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return NextResponse.next();
}
