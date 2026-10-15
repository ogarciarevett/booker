"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { secretSummary } from "@/lib/format.ts";
import { writeSetting } from "./settings-client.ts";

/** What the field needs to know; a secret's value is never part of it. */
export interface EditableSetting {
  readonly name: string;
  readonly secret: boolean;
  readonly configured: boolean;
  /** Saved from the dashboard (so it can be removed here). */
  readonly saved: boolean;
  /** Plain settings only. */
  readonly value?: string;
  readonly lastFour?: string;
}

/**
 * Edits one setting through this app's /api/settings route, then re-renders the page from the
 * server. A secret's input is write-only: it starts empty, is never filled from the server, and
 * is cleared after saving; a saved secret shows only its last four characters.
 */
export function SettingField({ setting }: { readonly setting: EditableSetting }) {
  const router = useRouter();
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const id = `setting-${setting.name}`;

  async function change(value: string | null): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    const result = await writeSetting((url, init) => fetch(url, init), setting.name, value);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    setReplacing(false);
    router.refresh();
    return true;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const value = String(new FormData(form).get("value") ?? "");
    if (await change(value)) {
      if (setting.secret) form.reset();
    }
  }

  const errorLine =
    error === undefined ? null : (
      <p className="text-xs font-medium text-destructive" role="alert">
        {error}
      </p>
    );
  const remove = setting.saved ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={busy}
      onClick={() => void change(null)}
    >
      Remove
    </Button>
  ) : null;

  if (setting.secret && setting.configured && !replacing) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">{secretSummary(setting.lastFour)}</p>
          <div className="flex gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setReplacing(true)}
            >
              Replace
            </Button>
            {remove}
          </div>
        </div>
        {errorLine}
      </div>
    );
  }

  return (
    <form className="space-y-2" onSubmit={(event) => void onSubmit(event)}>
      <div className="flex flex-wrap items-center gap-2">
        {setting.secret ? (
          <Input
            id={id}
            name="value"
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            placeholder={replacing ? "New value" : "Paste the value"}
            className="min-w-48 flex-1 font-mono"
          />
        ) : (
          <Input
            id={id}
            name="value"
            type="text"
            autoComplete="off"
            spellCheck={false}
            required
            defaultValue={setting.value ?? ""}
            className="min-w-48 flex-1 font-mono"
          />
        )}
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        {replacing ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setReplacing(false)}
          >
            Cancel
          </Button>
        ) : (
          remove
        )}
      </div>
      {errorLine}
    </form>
  );
}
