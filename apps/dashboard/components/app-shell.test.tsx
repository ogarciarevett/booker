import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell.tsx";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

function render(path: string): string {
  pathname = path;
  return renderToStaticMarkup(
    <AppShell>
      <p>Page content</p>
    </AppShell>,
  );
}

describe("AppShell", () => {
  it("offers a skip link to the main content, which holds the page", () => {
    const html = render("/");

    expect(html).toContain('href="#main"');
    expect(html).toMatch(/<main[^>]*id="main"[^>]*>.*Page content.*<\/main>/s);
  });

  it("explains the product at the entrance", () => {
    expect(render("/")).toContain("Your calls, quotes and bookings");
  });

  it("links every section from the main navigation", () => {
    const html = render("/");
    const nav = html.match(/<nav aria-label="Main".*?<\/nav>/s)?.[0] ?? "";

    for (const [href, label] of [
      ["/errands", "Errands"],
      ["/", "Calls"],
      ["/bookings", "Bookings"],
      ["/settings", "Settings"],
    ]) {
      expect(nav).toMatch(new RegExp(`href="${href}"[^>]*>(?:<[^>]+>)*${label}<`));
    }
  });

  it("marks the current section, a call page belonging to Calls", () => {
    expect(render("/settings")).toMatch(
      /aria-current="page"[^>]*href="\/settings"|href="\/settings"[^>]*aria-current="page"/,
    );
    const call = render("/calls/call-1");
    expect(call).toMatch(/aria-current="page"[^>]*href="\/"|href="\/"[^>]*aria-current="page"/);
    expect(call.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("marks Errands current on an errand's page", () => {
    expect(render("/errands/errand-1")).toMatch(
      /aria-current="page"[^>]*href="\/errands"|href="\/errands"[^>]*aria-current="page"/,
    );
  });
});
