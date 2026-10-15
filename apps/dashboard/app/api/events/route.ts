import { dashboardSettings, readTokenFile } from "../../../lib/server/booker.ts";
import { createEventsProxy } from "../../../lib/server/events-proxy.ts";

export const dynamic = "force-dynamic";

const settings = dashboardSettings(process.env, process.cwd());
const proxy = createEventsProxy({
  bookerUrl: settings.bookerUrl,
  readToken: readTokenFile(settings.tokenPath),
  fetch: (url, init) => fetch(url, init),
});

/** Booker's live call activity for this app's pages; see lib/server/events-proxy.ts. */
export function GET(request: Request): Promise<Response> {
  return proxy(request);
}
