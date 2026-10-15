# Public tree readiness

Public release uses a fresh repository from a reviewed squashed tree, after an explicit owner yes. This private repository keeps its history. A clean working tree does not make the historical commits safe to publish.

## Repeat the export scan

Run this from the checkout you intend to export. Keep any report outside that checkout:

```sh
pnpm privacy:scan
pnpm privacy:scan --report ../booker-oss/working-tree-privacy.json
```

The JSON must say `status: clean`, `unapprovedValues: 0` and `findings: []`. A finding makes the command exit 1; an execution problem exits 2. `pnpm check` includes this gate after lint, typecheck and tests. CI also runs `pnpm privacy:scan` after the test suite. Run the staged secret scan before every push too:

```sh
gitleaks git --pre-commit --staged --redact=100 --no-banner
```

The privacy scan covers tracked and untracked exportable files selected by Git. It excludes ignored local data and credentials, opens no ignored `.env` or `.local` files, and reports only categories, file paths and line numbers. It detects unapproved international and Spanish national phone numbers, email addresses, English and Spanish street addresses, owner names in quoted or unquoted assignments and setting tuples, voice identifiers, long agent and phone-number identifiers and Twilio SIDs. Tailnet hostnames, IPv4 addresses in the shared address range and Tailscale IPv6 prefixes also fail the gate. Phone fixtures use the existing fictional 555 and 01xx forms; names use exact Example Owner or Example Person labels with an optional numeric suffix, or Participant followed by one capital letter; a setting name can stand in for a value, addresses use Fictional Example, and email or infrastructure examples use reserved example domains.

## Runtime exact-value denylist

Patterns cannot recognize every personal name or address in free text. At scan time, the scanner also reads identity and credential settings from the shell environment. It compares values before applying fictional-fixture allowances. Alphabetic name entries match whole Unicode letter tokens, case-insensitively after NFC normalization, including snake-case, digit and punctuation delimiters and camel/acronym identifier boundaries. Thus fictional `Mint` matches `ownerMint`, `ownerMiNt` and `MINT_name`, but not `peppermint` or `emitInvoice`. Multiword and punctuated entries remain exact case-insensitive substring matches. Every non-name identity or credential setting, including all-letter credentials, always uses exact substring matching; the scanner API can also accept `{ value, exact: true }`. A match reports only `denylisted_value`, file and line. Neither reports nor errors contain the matched value; `denylistedValues` reports only the number loaded.

Additional known personal values belong in `BOOKER_PRIVACY_DENYLIST`, separated by newlines, supplied through the local environment or the existing macOS Keychain cache. Populate them through the owner's established 1Password workflow. Single alphabetic entries in this multiline list use name-token matching; put credentials and other opaque exact values in their dedicated settings instead. Never put values in a checked-in configuration file, a command argument or a report, and never echo the variable. No denylist file or command-line value option exists.

On macOS, the command reads the `booker` Keychain service without creating, updating or deleting credentials. It checks the same identity and credential account names as the environment and the `BOOKER_PRIVACY_DENYLIST` account. `BOOKER_PRIVACY_KEYCHAIN_ACCOUNTS` can list additional account names separated by commas; these must be environment-variable names, with the personal values stored only in the cache. Missing entries contribute nothing; any other read failure stops the scan with a value-free error and exit code 2.

Automated tests inject a fake reader and never access the real Keychain. Linux CI uses the runtime environment and the same pattern rules. `BOOKER_PRIVACY_KEYCHAIN=0` explicitly disables local Keychain reads for an environment-only scan. Before export, supply the owner's known names, phone numbers, addresses, email addresses and provider identifiers at scan time, verify the denylist count is populated, and require zero findings. A CI pass alone cannot certify values that were never supplied to that run. Token matching cannot distinguish personal names hidden inside all-lowercase concatenations from ordinary words. Supply the complete identifier or address as an exact setting when needed and review free text separately. No URL, hostname, path or contact allowlist bypasses the denylist: a name token in a URL still fails, while a substring inside a larger slug is treated like any other word.

## Media review

New binary files and symlinks fail the gate. The three dashboard screenshots and the silent demo recording were reviewed as fictional media. The [two generated illustrations](images/README.md) have separate provider terms and retain their original job-provenance tags. `scripts/privacy-media.json` approves only reviewed exact SHA-256 content; privacy approval does not establish licensing rights. Review any changed media before updating that file. A new hash alone is never evidence of privacy.

Pattern matching cannot establish that every free-text name, address or encoded identifier is fictional. Review free text and every media frame separately before export; gitleaks handles secrets alongside this scanner. Do not copy ignored files, private reports, Git metadata or historical refs into the future public tree. Personal configuration and generated ElevenLabs identifiers remain local, while credentials stay in 1Password with the macOS Keychain as cache.

## Current preparation

The live-call guide and tests use a reserved fictional public URL instead of a device or tailnet address. Owner-name and address fixtures are explicitly fictional, and phone masking tests retain their purpose with fake numbers. Simulation and dashboard media contain no live contacts or data. No repository was created, no visibility changed, and no history was rewritten.
