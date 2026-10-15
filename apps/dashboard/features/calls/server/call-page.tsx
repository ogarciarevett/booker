import "server-only";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LiveUpdates } from "@/components/live-updates.tsx";
import { Unavailable } from "@/components/unavailable.tsx";
import { BookerUnavailableError, bookerFromEnvironment } from "@/lib/server/booker.ts";
import { phoenixLink } from "@/lib/server/phoenix.ts";
import type { CallDetail } from "@/lib/types.ts";
import { CallDetailView } from "../components/call-detail.tsx";

/** Container for one call: reads it and its Phoenix session on the server. */
export async function CallPage({ callId }: { readonly callId: string }) {
  const { booker, settings } = bookerFromEnvironment();
  let call: CallDetail | undefined;
  try {
    call = await booker.getCall(callId);
  } catch (error) {
    if (!(error instanceof BookerUnavailableError)) throw error;
    return <Unavailable message={error.message} />;
  }
  if (call === undefined) notFound();
  const phoenix = await phoenixLink(settings.phoenixUrl, call.callId);
  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <Link href="/" className="text-sm text-muted-foreground no-underline hover:text-foreground">
          ← All calls
        </Link>
        <LiveUpdates callId={call.callId} />
      </div>
      <CallDetailView call={call} phoenix={phoenix} />
    </>
  );
}
