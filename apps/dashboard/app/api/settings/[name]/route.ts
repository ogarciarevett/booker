import { createSettingsWriteHandler } from "@/features/settings/server/settings-route.ts";
import { bookerFromEnvironment } from "@/lib/server/booker.ts";

export const dynamic = "force-dynamic";

const handle = createSettingsWriteHandler(bookerFromEnvironment().booker);

interface Context {
  readonly params: Promise<{ readonly name: string }>;
}

/** Saves one setting through Booker; see features/settings/server/settings-route.ts. */
export async function PUT(request: Request, context: Context): Promise<Response> {
  return handle("PUT", (await context.params).name, request);
}

/** Removes one saved setting through Booker. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  return handle("DELETE", (await context.params).name, request);
}
