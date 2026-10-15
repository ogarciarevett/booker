# Agent skills

Booker uses a small set of third-party agent skills to give AI coding agents current, vendor-maintained guidance. The skills themselves are not vendored: `skills-lock.json` is committed and `.claude/skills/` is ignored.

## Quick path

```bash
npx skills@1.7.0 experimental_install   # restore the skills listed in skills-lock.json
```

To add a skill, review its source first, then:

```bash
npx skills@1.7.0 add <owner/repo> --skill <name> -a claude-code -y
```

Commit the updated `skills-lock.json` together with a line in the table below.

## Installed skills

| Skill | Source | Why Booker uses it |
|-------|--------|--------------------|
| `mastra` | [mastra-ai/skills](https://github.com/mastra-ai/skills) | Workflows, agents, storage, and current Mastra APIs |
| `agents` | [elevenlabs/skills](https://github.com/elevenlabs/skills) | ElevenLabs Agents: tools, workflows, telephony |
| `setup-api-key` | [elevenlabs/skills](https://github.com/elevenlabs/skills) | Configuring and validating `ELEVENLABS_API_KEY` |
| `text-to-speech` | [elevenlabs/skills](https://github.com/elevenlabs/skills) | TTS with the cloned voice, also used by the Plan B runtime |
| `twilio-account-setup` | [twilio/ai](https://github.com/twilio/ai) | Account, credentials, and product enablement |
| `twilio-numbers-senders` | [twilio/ai](https://github.com/twilio/ai) | Buying and configuring the dedicated phone number |
| `twilio-regulatory-compliance-bundles` | [twilio/ai](https://github.com/twilio/ai) | Regulatory bundles required for Spanish numbers ([guidelines](https://www.twilio.com/en-us/guidelines/es/regulatory)) |
| `twilio-voice-outbound-calls` | [twilio/ai](https://github.com/twilio/ai) | Placing outbound calls |
| `twilio-voice-twiml` | [twilio/ai](https://github.com/twilio/ai) | TwiML for Media Streams in the Plan B runtime |
| `twilio-webhook-architecture` | [twilio/ai](https://github.com/twilio/ai) | Signed, idempotent webhook handling |

## Planned

| Skill | Source | When |
|-------|--------|------|
| Pipecat skills | [pipecat-ai/skills](https://github.com/pipecat-ai/skills) | When the Plan B voice runtime is built |

## Review checklist for new skills

- [ ] Published by the vendor's official organization, or reviewed line by line.
- [ ] No instructions to exfiltrate data, disable checks, or run unreviewed scripts.
- [ ] License allows use in this project.
