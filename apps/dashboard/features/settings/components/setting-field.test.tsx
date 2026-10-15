// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EditableSetting, SettingField } from "./setting-field.tsx";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

// React only flushes updates inside act() when it knows it runs under a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred {
  readonly promise: Promise<Response>;
  resolve(response: Response): void;
}

function deferred(): Deferred {
  let resolve: (response: Response) => void = () => {};
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SettingField", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  function render(setting: EditableSetting): void {
    act(() => {
      root.render(<SettingField setting={setting} />);
    });
  }

  const input = () => container.querySelector("input");
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);

  async function click(label: string): Promise<void> {
    await act(async () => {
      button(label)?.click();
    });
  }

  async function submit(value: string): Promise<void> {
    const field = input();
    if (field === null) throw new Error("expected an input");
    field.value = value;
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fetchMock = vi.fn(async () => json({ setting: {} }));
    vi.stubGlobal("fetch", fetchMock);
    refresh.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("clears a secret's write-only input once it is saved, and refreshes the page", async () => {
    render({ name: "ELEVENLABS_API_KEY", secret: true, configured: false, saved: false });

    expect(input()?.type).toBe("password");
    expect(input()?.value).toBe("");
    await submit("a-new-secret-value-0001");

    expect(fetchMock).toHaveBeenCalledWith("/api/settings/ELEVENLABS_API_KEY", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "a-new-secret-value-0001" }),
      cache: "no-store",
    });
    expect(input()?.value).toBe("");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("offers Replace for a saved secret, and Cancel goes back to its summary", async () => {
    render({
      name: "TWILIO_AUTH_TOKEN",
      secret: true,
      configured: true,
      saved: true,
      lastFour: "1234",
    });

    expect(container.textContent).toContain("Configured · ends in …1234");
    expect(input()).toBeNull();
    await click("Replace");
    expect(input()?.type).toBe("password");
    expect(input()?.value).toBe("");
    expect(container.textContent).not.toContain("ends in");
    await click("Cancel");
    expect(input()).toBeNull();
    expect(container.textContent).toContain("Configured · ends in …1234");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes a saved value with a DELETE and no value", async () => {
    render({
      name: "TWILIO_PHONE_NUMBER",
      secret: false,
      configured: true,
      saved: true,
      value: "+15550100100",
    });

    await click("Remove");

    expect(fetchMock).toHaveBeenCalledWith("/api/settings/TWILIO_PHONE_NUMBER", {
      method: "DELETE",
      cache: "no-store",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows Booker's refusal as an alert and keeps the page as it is", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        { error: "invalid_value", detail: "BOOKER_PORT must be a whole number from 1 to 65535" },
        400,
      ),
    );
    render({ name: "BOOKER_PORT", secret: false, configured: false, saved: false });

    await submit("eighty");

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "BOOKER_PORT must be a whole number from 1 to 65535",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("says it is saving and blocks a second change until the answer comes", async () => {
    const answer = deferred();
    fetchMock.mockReturnValueOnce(answer.promise);
    render({
      name: "BOOKER_OWNER_NAME",
      secret: false,
      configured: true,
      saved: true,
      value: "Alex",
    });

    await submit("Sam");

    expect(button("Saving…")?.disabled).toBe(true);
    expect(button("Remove")?.disabled).toBe(true);
    await act(async () => {
      answer.resolve(json({ setting: {} }));
    });
    expect(button("Save")?.disabled).toBe(false);
  });
});
