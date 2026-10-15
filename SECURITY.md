# Security Policy

Booker will place phone calls and make bookings on someone's behalf, so vulnerabilities can cost money or expose personal data. Please report them privately.

## How to report

1. Open the repository's **Security** tab and choose **Report a vulnerability** (GitHub private vulnerability reporting).
2. Describe the issue, affected files or endpoints, and steps to reproduce.
3. Do not include real personal data or live secrets in the report.

Please do not open public issues, discussions, or pull requests for vulnerabilities until a fix is available.

## In scope

| Area | Examples |
|------|----------|
| Secrets | A key, token, or credential committed or logged |
| Webhook authenticity | Bypassing the HMAC signature check or replaying events |
| Commit gate | Obtaining a booking grant without passing the policy checks, or two active grants for one errand |
| Prompt injection | Provider speech or web content that changes budgets, permissions, or the errand |
| Personal data | Participant details, recordings, or transcripts exposed beyond the services an errand needs |

## What the project does

- gitleaks scans staged changes before each commit and the full history in CI.
- Secrets live only in environment variables and never in prompts, frontend code, or logs.
- Webhooks from voice providers will be verified with HMAC signatures and stored idempotently.
- Money, dates, permissions, and booking exclusivity are enforced in code, never by a language model.

## Supported versions

Booker is in early development. Only the `main` branch receives fixes.
