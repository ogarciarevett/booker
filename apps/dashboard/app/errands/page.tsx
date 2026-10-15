import type { Metadata } from "next";
import { ErrandsPage } from "@/features/errands/server/errands-page.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Errands" };

export default function Page() {
  return <ErrandsPage />;
}
