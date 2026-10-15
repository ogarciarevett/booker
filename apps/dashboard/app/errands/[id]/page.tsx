import type { Metadata } from "next";
import { ErrandPage } from "@/features/errands/server/errand-page.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Errand" };

export default async function Page({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ErrandPage errandId={id} />;
}
