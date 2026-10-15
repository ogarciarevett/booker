# Vision

Booker is a general call-and-booking assistant. It collects quotes by phone, compares them against rules you set, and closes exactly one booking per errand. The core never knows what kind of business it is calling: every errand arrives as data.

## Goals

- **General from day one.** A driving-school course and a restaurant table use the same system; only the brief changes.
- **Safe by construction.** Budgets, dates, permissions, and booking exclusivity are enforced in code, not by a language model.
- **Honest records.** Every offer keeps its source and evidence. What was not confirmed stays unknown.
- **Reusable.** Voice, authorized contacts, preferences, and standing rules carry over between errands.

## The errand model

An errand brief holds everything a call needs and nothing more.

| Field | Meaning |
|-------|---------|
| Objective | What must be achieved, in one sentence |
| Participants | Who the booking is for, with per-person details kept separate |
| Location | Where, and which alternative areas are acceptable |
| Dates and flexibility | Target window and how far it may move |
| Hard requirements | Conditions an offer must meet to be considered at all |
| Preferences | Tie-breakers among offers that meet every requirement |
| Spend limits | Per person, total, deposit, and acceptable cancellation terms |
| Authorized actions | What the assistant may do without asking (quote, hold, book, pay) |
| Completion criteria | The observable condition that closes the errand |
| Questions | What each call must find out, generated from the brief |
| Candidate providers | Who to call, with contact details kept locally |
| Shareable data | Which personal details may be told to a provider |

A language model drafts the brief from your request and flags missing required data. The backend validates every field. Templates are optional and editable; adding a new kind of errand must not require changes to the core or a new agent deployment.

## Example errands

| Errand | Specific data | Done when |
|--------|---------------|-----------|
| Driving school | Two students, licence category, each student's theory-exam status, course and exam dates, included practical lessons, individual and joint price | Two seats confirmed in the same school with compatible dates; pending enrollment steps identified per person |
| Restaurant | Party size, day, time and margin, area, dietary restrictions that may be shared | The restaurant confirms a table for the whole party at the agreed date and time, with deposit and cancellation inside the limits |

The first real errand is two seats in the same intensive driving-licence course (theory and practice), booked together.

## Lifecycle

```text
prepare → query → compare (when there is more than one offer) → commit → verify
```

A language model proposes the next step, the decision service chooses among the allowed actions, and the backend checks authorization before executing it. Content from websites and conversations is information, never permission to change the errand.

## What quote calls ask

Questions come from the brief. For the driving-school errand they include:

- Seats for every participant in the same course, compatible dates, and any group discount.
- Start and end dates for each phase, exam dates, and whether each date is confirmed or estimated.
- Whether the phases can run back to back, and what happens if an exam is failed.
- Price breakdown: enrollment, materials, fees, exam presentation, medical check, included and extra lessons, taxes, and excluded amounts.
- Lesson count and length, transmission type, and daily availability.
- Accommodation and travel, and whether rates are per room or per person.
- Deposit, offer expiry, cancellation terms, and required documents.
- Whether booking by phone on the participant's behalf is possible, and how written confirmation is sent.

The agent repeats decisive amounts and dates back to the provider. Each offer records the provider, query date, source, evidence, and pending fields.

## Comparison rules

1. Apply hard requirements first: seats for everyone, accepted location, dates, options, and budget.
2. Rank the remaining offers by comparable total cost for the group: every participant's individual costs plus shared costs, accommodation, and travel.
3. Subtract only confirmed discounts. Never invent competitor quotes to negotiate.
4. Show the per-person price next to the group total.
5. For variable extras (such as additional lessons), show the unit price and equal-quantity scenarios across providers. Never assume how many a person will need.
6. If no offer meets a requirement, show the closest confirmed alternative and why it differs.

## Commitment rules

- Quote calls have no permission to commit.
- After comparison, a single operation earns the right to book for that errand.
- Before the agent speaks a binding acceptance, the backend grants permission for that specific offer, checking price, availability, and terms *during the call*. Checking after the call is too late.
- Group bookings are all-or-nothing: if only part of the group can be booked, the assistant looks for alternatives instead of booking a partial group, unless you explicitly authorized it.
- If a confirmation arrives incomplete, it is resolved with the same provider before any other provider is contacted.
- Verbal reservation, written confirmation, and completed enrollment are separate states. A finished call is not a booking.
- If a call drops after a possible acceptance, the assistant checks the status with that provider before booking elsewhere.
- Payments go through the provider's official channel; automated payment only within an explicit limit.

## Standing rules

You can set permanent rules (acceptable dates, maximum total, maximum deposit, acceptable cancellation) with per-errand exceptions. Within those rules the assistant books on its own. It asks you only when required data is missing or a condition exceeds your authorization. Your calendar is checked before closing.

## Pilot readiness

The pilot is ready when Booker:

- [ ] Captures an offer with checked amounts and dates.
- [ ] Keeps unconfirmed conditions as unknown.
- [ ] Respects spend, duration, and call limits.
- [ ] Cannot create two incompatible bookings for the same errand.
- [ ] Switches from a driving-school simulation to a restaurant simulation by changing only the brief.

Rollout order: a test call to yourself, then one real provider, then the parallel round.

## Out of scope for now

- Negotiating with invented competitor offers.
- Paying without an explicit, pre-authorized limit.
- Calling people other than businesses you choose.
- Hosting the assistant for other users.
