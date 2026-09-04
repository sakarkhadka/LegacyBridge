# LegacyBridge

Discover UI workflows once with an LLM. Replay them deterministically without one.

```text
Model discovers
  -> Artifact captures
  -> Runtime executes
  -> Human resolves uncertainty
```

This repository is being built for the Computer-Use Automation System take-home project. The current state is Phase 2 complete: the core contracts are defined and a local legacy banking proxy app is available for discovery and replay work. Implementation progress is tracked in [status.md](status.md).

## Setup

```bash
npm install
npx playwright install chromium
npm run typecheck
npm test
```

## Planned Demo Path

```bash
npm run demo-app
npm run demo:discover
npm run demo:replay
npm run demo:not-found
npm run demo:recovery
npm run demo:handoff
```

These commands are scaffolded now and will be wired up as each implementation phase lands.

Surface adapter debug:

```bash
npm run debug:surface
```

This starts a temporary demo app, launches Chromium through Playwright, locates the `Member Number` field, locates the `Search` button, navigates to member `12345`, locates the Savings balance cell inside the accounts iframe, and extracts `$3,182.46`.

## Demo App

Start the local proxy target:

```bash
npm run demo-app
```

Open:

```text
http://localhost:3000/servicing/search
```

Manual checks:

```text
12345 -> valid member with savings balance $3,182.46
54321 -> valid member with savings balance $8,044.19
00000 -> Member not found
88888 -> Permission denied
?scenario=session-expired -> Session Expired
?scenario=interstitial -> System Notice / Maintenance scheduled tonight
?scenario=slow -> delayed page response
?scenario=error -> Application error
```

The risky-action flow is available from a member details page through `Open Sub Account`, then `Review`, then `Confirm Opening`. The final confirmation action is intentionally marked in the UI as irreversible so later policy and human-approval phases have a concrete target.

## Project Structure

```text
src/artifact       Capability types, schemas, validation, serialization
src/catalog        Agent-facing capability catalog
src/cli            Local commands and demos
src/discovery      LLM-driven observe/decide/act discovery loop
src/evidence       Structured JSONL logs, screenshots, traces
src/intervention   Same-session human handoff state and operator seam
src/policy         Allowlists, risk classification, redaction
src/replay         Deterministic capability execution path
src/surface        Surface abstraction and Playwright adapter
demo-app           Local legacy banking proxy target
capabilities       Saved capability artifacts
evidence           Curated demo evidence
tests              Focused tests for architectural guarantees
```

## Current Verification

```bash
npm run typecheck
npm test
npm audit --omit=optional
```

Phase 1 tests validate that a well-formed capability artifact is accepted, malformed contracts are rejected, business outcomes are distinct from execution failures, and target descriptors do not leak Playwright selectors into the artifact schema. Phase 2 tests validate the local legacy banking proxy app and its deterministic runtime scenarios. Phase 3 tests validate the Playwright-backed surface adapter using semantic `TargetDescriptor` inputs.
