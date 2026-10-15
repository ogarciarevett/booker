const CREDENTIAL_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)(?:_|$)/;

/**
 * Whether an environment variable's name says it holds a credential (`*_KEY`, `*_TOKEN`,
 * `*_SECRET`, `*_PASSWORD`). Span redaction treats such values as secrets, and `pnpm phoenix`
 * never passes such variables to Phoenix: both use this one rule.
 */
export function isCredentialName(name: string): boolean {
  return CREDENTIAL_NAME.test(name);
}
