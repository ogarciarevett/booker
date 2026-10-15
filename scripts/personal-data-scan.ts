import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, type Stats, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface Finding {
  readonly category: string;
  readonly file: string;
  readonly line: number;
}

/** Alphabetic strings are name tokens; settings can require literal substring matching. */
export type DenylistedValue = string | { readonly value: string; readonly exact: true };

function* deniedOffsets(text: string, entry: DenylistedValue): Generator<number> {
  const value = (typeof entry === "string" ? entry : entry.value).trim().normalize("NFC");
  if (!value) return;
  const lower = value.toLowerCase();
  if (typeof entry === "string" && /^\p{L}[\p{L}\p{M}]*$/u.test(value)) {
    for (const word of text.matchAll(/[\p{L}\p{M}]+/gu)) {
      if (word[0].toLowerCase() === lower) {
        yield word.index;
        continue;
      }
      // Lower-to-upper and acronym-to-title transitions retain personal identifier tokens.
      const parts = word[0].split(/(?<=[\p{Ll}\p{M}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u);
      let at = word.index;
      for (const [index, part] of parts.entries()) {
        let candidate = "";
        for (const next of parts.slice(index)) {
          candidate += next;
          if (candidate.toLowerCase() === lower) yield at;
          if (candidate.length >= value.length) break;
        }
        at += part.length;
      }
    }
    return;
  }
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const match of text.matchAll(new RegExp(escaped, "giu"))) yield match.index;
}

const fictionalName = (value: string) =>
  value.trim() === "" ||
  value === "BOOKER_OWNER_NAME" ||
  /^(?:Example (?:Owner|Person)(?: \d+)?|Participant [A-Z])$/.test(value.trim());

const RULES: readonly { category: string; pattern: RegExp; fake?: (value: string) => boolean }[] = [
  {
    category: "phone",
    pattern:
      /(?<![\w])(?:\+[1-9]\d{6,14}|\+\d{1,3}[ .-]\d[\d .()-]{6,20}\d|\b\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4})(?!\d)/g,
    fake: (value) =>
      /^(?:\+1555(?:555)?01\d{0,5}|55555501\d{2})$/.test(value.replaceAll(/[ .()-]/g, "")),
  },
  {
    category: "phone",
    pattern:
      /(?<![\w+.-])(?:[6789]\d{8}|[6789]\d{1,2}(?:[ .-]\d{2,3}){2,3}|00\d{2,3}[ .-]?[6789]\d{2}(?:[ .-]?\d{2,3}){2,3})(?![\w.-])/g,
  },
  { category: "twilio_sid", pattern: /\b(?:AC|SK|CA|PN|AP|MG|VA|TK)[a-f\d]{32}\b/gi },
  { category: "tailnet_hostname", pattern: /\b[\w.-]+\.ts\.net\b/gi },
  { category: "phone_number_id", pattern: /\bphnum_[a-z\d]{16,}\b/gi },
  {
    category: "tailnet_ip",
    pattern:
      /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:25[0-5]|2[0-4]\d|1?\d{1,2})\.(?:25[0-5]|2[0-4]\d|1?\d{1,2})(?![\w.])|\bfd7a:115c:a1e0:/gi,
  },
  { category: "agent_id", pattern: /\bagent_[a-z\d]{16,}\b/gi },
  {
    category: "email",
    pattern: /\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi,
    fake: (value) =>
      /@(?:[\w.-]+\.)?(?:example\.(?:com|org|net)|[\w-]+\.example|example\.test)$/i.test(value),
  },
  {
    category: "address",
    pattern:
      /\b\d{1,5}\s+[a-z][a-z .]{1,40}\s+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Boulevard|Blvd|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Parkway|Pkwy|Highway|Hwy)\b/gi,
    fake: (value) => /^\d+ Fictional Example (?:Street|Road|Avenue)$/i.test(value),
  },
  {
    category: "address",
    pattern:
      /\b(?:Calle|C\/|Avenida|Avda\.?|Plaza|Pza\.?|Paseo|Carrer|Camino|Ronda|Traves[ií]a)\s+[^\n,]{2,40}?,?\s+\d{1,4}\b/gi,
  },
  {
    category: "name",
    pattern:
      /(?:BOOKER_OWNER_NAME|ownerName|owner_name|full_name|customer_name|contact_name|participantName)[\s"']*[:=]\s*["']([^"'\\\r\n${}]+)["']/gi,
    fake: fictionalName,
  },
  {
    category: "name",
    pattern: /\bBOOKER_OWNER_NAME[ \t]*=[ \t]*([^\s"'#\\${}][^\r\n#"'\\${}]*)/g,
    fake: fictionalName,
  },
  {
    category: "name",
    pattern: /["']BOOKER_OWNER_NAME["']\s*,\s*["']([^"'\\\r\n${}]+)["'](?=\s*[\])])/g,
    fake: fictionalName,
  },
  {
    category: "voice_id",
    pattern: /(?:ELEVENLABS_VOICE_ID|voiceId|voice_id|voice)[\s"']*[:=]\s*["']([a-z\d]{16,})["']/gi,
  },
  {
    category: "voice_id",
    pattern: /\bELEVENLABS_VOICE_ID[ \t]*=[ \t]*([a-z\d]{16,})\b/gi,
  },
  {
    category: "voice_id",
    pattern: /["']ELEVENLABS_VOICE_ID["']\s*,\s*["']([a-z\d]{16,})["']/gi,
  },
];

/** Findings contain only locations. Unknown contacts fail; only explicit fake fixtures pass. */
export function scanText(
  file: string,
  text: string,
  denylist: readonly DenylistedValue[] = [],
): Finding[] {
  const findings: Finding[] = [];
  const normalized = text.normalize("NFC");
  const seen = new Set<string>();
  for (const entry of denylist) {
    for (const at of deniedOffsets(normalized, entry)) {
      // An exact setting and a name entry may refer to the same occurrence.
      const key = `${at}:${(typeof entry === "string" ? entry : entry.value).trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        category: "denylisted_value",
        file,
        line: normalized.slice(0, at).split("\n").length,
      });
    }
  }
  for (const rule of RULES) {
    for (const match of text.matchAll(new RegExp(rule.pattern))) {
      const value = match[1] ?? match[0];
      if (rule.fake?.(value)) continue;
      findings.push({
        category: rule.category,
        file,
        line: text.slice(0, match.index).split("\n").length,
      });
    }
  }
  return findings;
}

/** Git selects exportable files, including new files, without opening ignored local data. */
export function scanTree(root: string, denylist: readonly DenylistedValue[] = []) {
  const selected = execFileSync(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const paths = [...new Set(selected.split("\0").filter(Boolean))];
  let approved: Record<string, string> = {};
  try {
    approved = JSON.parse(readFileSync(join(root, "scripts/privacy-media.json"), "utf8"));
  } catch {
    /* No media approved. */
  }
  const findings: Finding[] = [];
  const reviewedMedia: string[] = [];
  let scannedFiles = 0;
  for (const file of paths) {
    const path = join(root, file);
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      findings.push({ category: "non_regular_file", file, line: 0 });
      continue;
    }
    const bytes = readFileSync(path);
    const media =
      /\.(?:png|jpg|jpeg|gif|webp|mp4|webm|mov|wav|mp3|pdf)$/i.test(file) || bytes.includes(0);
    if (media) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (approved[file] === hash) reviewedMedia.push(file);
      else findings.push({ category: "unreviewed_binary", file, line: 0 });
      continue;
    }
    scannedFiles++;
    findings.push(...scanText(file, bytes.toString("utf8"), denylist));
  }
  return {
    status: findings.length === 0 ? "clean" : "not_clean",
    unapprovedValues: findings.length,
    scannedFiles,
    denylistedValues: denylist.length,
    reviewedMedia,
    findings,
    scope:
      "Git exportable working tree, including untracked files. Ignored local data and history are excluded.",
  };
}

// Only identity and credential settings participate: ports and other defaults would match prose.
const PRIVATE_SETTINGS = [
  "BOOKER_OWNER_NAME",
  "BOOKER_OWNER_ADDRESS",
  "BOOKER_OWNER_EMAIL",
  "TWILIO_PHONE_NUMBER",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "ELEVENLABS_VOICE_ID",
  "ELEVENLABS_AGENT_ID",
  "ELEVENLABS_QUOTE_AGENT_ID",
  "ELEVENLABS_COMMIT_AGENT_ID",
  "ELEVENLABS_PHONE_NUMBER_ID",
  "ELEVENLABS_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "BOOKER_CONTROL_TOKEN",
  "ELEVENLABS_WEBHOOK_SECRET",
  "BOOKER_TAILNET_HOSTNAME",
  "BOOKER_TAILNET_IP",
] as const;

type KeychainReader = (account: string) => Promise<string | undefined>;

/** Read-only, runtime values stay in memory and never enter findings, files or subprocess argv. */
export async function loadDenylist(
  environment: NodeJS.ProcessEnv = process.env,
  readKeychain?: KeychainReader,
): Promise<DenylistedValue[]> {
  const settingValue = (name: string, value: string): DenylistedValue =>
    name === "BOOKER_OWNER_NAME" ? value : { value, exact: true };
  const values: DenylistedValue[] = PRIVATE_SETTINGS.map((name) =>
    settingValue(name, environment[name] ?? ""),
  );
  values.push(...(environment["BOOKER_PRIVACY_DENYLIST"] ?? "").split(/\r?\n/));
  const url = environment["PUBLIC_BASE_URL"];
  if (url) {
    values.push({ value: url, exact: true });
    try {
      values.push({ value: new URL(url).hostname, exact: true });
    } catch {
      /* Patterns still inspect literal hosts. */
    }
  }
  if (readKeychain) {
    const extra = (environment["BOOKER_PRIVACY_KEYCHAIN_ACCOUNTS"] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (extra.some((name) => !/^[A-Z][A-Z\d_]*$/.test(name)))
      throw new Error("Privacy denylist Keychain account names must be environment variable names");
    for (const account of new Set([...PRIVATE_SETTINGS, "BOOKER_PRIVACY_DENYLIST", ...extra])) {
      try {
        const value = await readKeychain(account);
        if (value)
          values.push(
            ...(account === "BOOKER_PRIVACY_DENYLIST"
              ? value.split(/\r?\n/)
              : [settingValue(account, value)]),
          );
      } catch {
        throw new Error("Privacy denylist could not read Keychain");
      }
    }
  }
  const unique = new Map<string, DenylistedValue>();
  for (const entry of values) {
    const value = (typeof entry === "string" ? entry : entry.value).trim();
    if (value)
      unique.set(
        `${typeof entry}:${value}`,
        typeof entry === "string" ? value : { value, exact: true },
      );
  }
  return [...unique.values()];
}

async function main() {
  const args = process.argv.slice(2);
  const rootAt = args.indexOf("--root");
  const reportAt = args.indexOf("--report");
  const root = resolve(rootAt < 0 ? process.cwd() : (args[rootAt + 1] ?? "."));
  try {
    let readKeychain: KeychainReader | undefined;
    if (process.platform === "darwin" && process.env["BOOKER_PRIVACY_KEYCHAIN"] !== "0") {
      const { macosKeychain } = await import("../src/settings/adapters/macos-keychain.ts");
      const cache = macosKeychain();
      readKeychain = (account) => cache.get(account);
    }
    const report = scanTree(root, await loadDenylist(process.env, readKeychain));
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const reportPath = args[reportAt + 1];
    if (reportAt >= 0 && reportPath !== undefined)
      writeFileSync(resolve(reportPath), json, { mode: 0o600 });
    process.stdout.write(json);
    process.exitCode = report.unapprovedValues === 0 ? 0 : 1;
  } catch {
    process.stderr.write(
      "Personal data scan failed. Check repository access and report destination. No file values are printed.\n",
    );
    process.exitCode = 2;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) void main();
