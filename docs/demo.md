# A short Booker demo

Show a fictional dinner errand moving from a quote to one verbal reservation in about 90 seconds. The recording must identify this as a simulation. No phone, provider account, API credential, live database or real participant is needed.

## Prepare

Use a separate checkout with Node.js 24, pnpm and gitleaks installed. Run `pnpm install`, then `pnpm check`. The fake errand is [demo.example.json](../examples/errands/demo.example.json): Participant A through D, fictional restaurants, fictional numbers, a EUR 200 group cap, and permission to book only inside the simulated scenario. Its dates are fixed to the simulation clock, not an instruction to place a call today.

Run the entire simulation suite:

```sh
pnpm simulate
```

For the short recording, isolate the four restaurant and demo runs:

```sh
pnpm test tests/scenarios/restaurant.test.ts --reporter=verbose
```

Both fixtures exercise the same real call planner, authenticated voice-tool requests, signed webhook, ranking and commit authorization against in-memory and temporary SQLite stores. The voice runtime is in-process, so no outgoing phone call occurs. The SQLite database is temporary and removed by the tests.

## Simulation replay recording

The silent 90-second browser capture is [booker-simulation-demo.mp4](demo/booker-simulation-demo.mp4). It labels every screen as fictional and replays the verified simulation path rather than pretending to dial a phone. The validation run completed with six scenario files and fourteen passing tests.

To replay the same presentation, serve only the static demo folder on loopback:

```sh
python3 -m http.server 18992 --bind 127.0.0.1 --directory examples/demo
```

Open `http://127.0.0.1:18992/` and record only that browser viewport. The presentation advances for 90 seconds and can be restarted with its replay button. It makes no backend requests and loads no external assets. Stop the static server after recording.

## Screen recording script

| Time | On screen | Narration |
| --- | --- | --- |
| 0 to 10 seconds | Title card: Booker, simulated dinner errand | “Booker collects quotes, compares them against your rules, and checks permission before a booking.” |
| 10 to 25 seconds | The fictional brief, focused on objective, four participant labels and the group cap | “This brief is data. These contacts are fictional, and this run makes no real phone call.” |
| 25 to 45 seconds | Run `pnpm test tests/scenarios/restaurant.test.ts` with the verbose reporter | “The scripted provider talks through the same authenticated tools and signed webhook as a live voice agent.” |
| 45 to 65 seconds | The scenario assertions for the eligible quote and permission check | “A quote does not authorize a booking. The code checks the agreed terms during the simulated commit call.” |
| 65 to 80 seconds | The verbal booking assertion and passing tests for both store types | “One verbal reservation is recorded for the whole party. Written confirmation and completed enrollment are separate states.” |
| 80 to 90 seconds | Closing card: simulation complete, live demo pending owner approval | “The live adapter is implemented. Recording a real call is a separate owner decision.” |

Record only the dedicated checkout window. Hide notifications and unrelated terminals. Keep shell environment dumps, local errands, credentials, provider dashboards, account ids and the live workspace outside the capture. Any dashboard footage must use clearly labeled fictional fixtures; simulation tests do not populate a running dashboard.

## Optional real phone recording

This phase is pending an explicit owner yes. Choose either the simulation-only recording, which is recommended now, or a quote-only test call to the owner's consenting phone. The latter requires owner approved timing and recording consent, a dedicated local errand with only that phone, a configured voice and webhook, and confirmation that the shared live setup is ready.

The owner enters the real number locally and keeps credentials in 1Password with the macOS Keychain as cache. Do not place a call, synchronize agents, expose routes, or touch the live workspace as part of this preparation. A later approved live session must coordinate with the live setup worker and retain personal recordings only in ignored local storage. Before sharing footage, redact every personal identifier and confirm the recording notice and consent are audible.
