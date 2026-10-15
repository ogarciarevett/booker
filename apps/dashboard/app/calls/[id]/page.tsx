import type { Metadata } from "next";
import { CallPage } from "@/features/calls/server/call-page.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Call" };

export default async function Page({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CallPage callId={id} />;
}
