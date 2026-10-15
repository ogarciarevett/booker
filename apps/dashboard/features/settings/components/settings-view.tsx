import { RotateCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { secretSummary } from "@/lib/format.ts";
import type { SettingsList, SettingView } from "@/lib/types.ts";
import { cn } from "@/lib/utils";
import { type EditableSetting, SettingField } from "./setting-field.tsx";

const READ_ONLY_SENTENCE =
  "Defined in .env (or your terminal environment); remove it there to edit it here.";

/** Where the value in effect comes from, as the owner reads it. */
export function sourceLabel(setting: Pick<SettingView, "source" | "secret">): string {
  switch (setting.source) {
    case "dotenv":
      return ".env file";
    case "environment":
      return "Terminal environment";
    case "store":
      return setting.secret ? "Keychain" : "Saved in dashboard";
    case "unset":
      return "Not set";
  }
}

const SOURCE_TONES: Readonly<Record<SettingView["source"], string>> = {
  dotenv: "border-status-warning/50 text-status-warning",
  environment: "border-status-warning/50 text-status-warning",
  store: "border-status-success/40 text-status-success",
  unset: "text-muted-foreground",
};

export function SourceBadge({ setting }: { readonly setting: SettingView }) {
  return (
    <Badge variant="outline" className={cn("font-medium", SOURCE_TONES[setting.source])}>
      {sourceLabel(setting)}
    </Badge>
  );
}

/** Only what the interactive field needs: a secret's value is never handed to the browser. */
function editable(setting: SettingView): EditableSetting {
  return {
    name: setting.name,
    secret: setting.secret,
    configured: setting.configured,
    saved: setting.source === "store",
    ...(setting.secret || setting.value === undefined ? {} : { value: setting.value }),
    ...(setting.lastFour === undefined ? {} : { lastFour: setting.lastFour }),
  };
}

function ReadOnly({ setting }: { readonly setting: SettingView }) {
  const fromEnvironment = setting.source === "dotenv" || setting.source === "environment";
  return (
    <div className="space-y-2">
      {setting.secret ? (
        setting.configured ? (
          <p className="text-sm font-medium">{secretSummary(setting.lastFour)}</p>
        ) : null
      ) : setting.value === undefined ? null : (
        <Input
          id={`setting-${setting.name}`}
          type="text"
          readOnly
          value={setting.value}
          aria-describedby={`setting-${setting.name}-help`}
          className="font-mono text-muted-foreground"
        />
      )}
      <p className="text-xs text-muted-foreground" id={`setting-${setting.name}-help`}>
        {fromEnvironment ? READ_ONLY_SENTENCE : "Read from .env or the environment only."}
      </p>
    </div>
  );
}

function SettingRow({ setting }: { readonly setting: SettingView }) {
  return (
    <li
      className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-8"
      aria-labelledby={`setting-${setting.name}-name`}
    >
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <label
            className="font-mono text-sm font-medium break-all"
            id={`setting-${setting.name}-name`}
            htmlFor={`setting-${setting.name}`}
          >
            {setting.name}
          </label>
          <SourceBadge setting={setting} />
        </div>
        <p className="text-sm text-muted-foreground">{setting.description}</p>
        {setting.applies === "restart" ? (
          <p className="text-xs text-muted-foreground">Applies after a restart</p>
        ) : null}
        {setting.restartPending ? (
          <p className="flex items-center gap-1.5 text-xs font-medium text-status-warning">
            <RotateCw aria-hidden="true" className="size-3" />
            Restart Booker to apply this change.
          </p>
        ) : null}
      </div>
      {setting.editable ? (
        <SettingField setting={editable(setting)} />
      ) : (
        <ReadOnly setting={setting} />
      )}
    </li>
  );
}

/**
 * Every setting, grouped as the catalog groups them, each with where its value comes from. Values
 * from `.env` or the environment are shown read-only (they win, so they are changed there);
 * secrets show only whether they are configured and their last four characters.
 */
export function SettingsView({ groups, settings }: SettingsList) {
  const pending = settings.filter((setting) => setting.restartPending);
  return (
    <div className="space-y-10">
      {pending.length > 0 ? (
        <section
          role="status"
          aria-labelledby="restart-heading"
          className="flex gap-3 rounded-lg border border-status-warning/50 bg-card p-5"
        >
          <RotateCw aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />
          <div className="space-y-1">
            <h2 id="restart-heading" className="text-sm font-semibold">
              Restart Booker to apply
            </h2>
            <p className="text-sm text-muted-foreground">
              {pending.map((setting) => setting.name).join(", ")} changed since Booker started. Stop{" "}
              <code className="font-mono">pnpm booker serve</code> and start it again.
            </p>
          </div>
        </section>
      ) : null}
      <p className="max-w-2xl text-sm text-muted-foreground">
        A value in <code className="font-mono">.env</code> or your terminal environment always wins.
        Everything else is saved here: secrets in the macOS Keychain, the rest in Booker's database.
        Most changes apply at once; the ones marked otherwise apply after a restart.
      </p>
      {groups.map((group) => {
        const inGroup = settings.filter((setting) => setting.group === group);
        if (inGroup.length === 0) return null;
        const id = `group-${group.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
        return (
          <section key={group} aria-labelledby={id} className="space-y-3">
            <h2 id={id} className="text-base font-semibold tracking-tight">
              {group}
            </h2>
            <ul className="divide-y rounded-lg border bg-card">
              {inGroup.map((setting) => (
                <SettingRow key={setting.name} setting={setting} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
