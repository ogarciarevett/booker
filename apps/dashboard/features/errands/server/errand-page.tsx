import "server-only";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LiveUpdates } from "@/components/live-updates.tsx";
import { Unavailable } from "@/components/unavailable.tsx";
import type { ErrandDetail } from "@/lib/errands.ts";
import { BookerUnavailableError, bookerFromEnvironment } from "@/lib/server/booker.ts";
import { ErrandDetailView } from "../components/errand-detail.tsx";
import { KeyboardShortcuts } from "../components/keyboard-shortcuts.tsx";

/** Container for one errand: reads its overview on the server. */
export async function ErrandPage({ errandId }: { readonly errandId: string }) {
  const { booker } = bookerFromEnvironment();
  let errand: ErrandDetail | undefined;
  try {
    errand = await booker.getErrand(errandId);
  } catch (error) {
    if (!(error instanceof BookerUnavailableError)) throw error;
    return <Unavailable message={error.message} />;
  }
  if (errand === undefined) notFound();
  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <Link
          href="/errands"
          className="text-sm text-muted-foreground no-underline hover:text-foreground"
        >
          ← All errands
        </Link>
        <div className="flex flex-col items-end gap-2">
          <LiveUpdates watch="errands" />
          <KeyboardShortcuts backHref="/errands" />
        </div>
      </div>
      <ErrandDetailView errand={errand} />
    </>
  );
}
