# LegacyBridge

Discover UI workflows once with an LLM. Replay them deterministically without one.

```text
Model discovers
  -> Artifact captures
  -> Runtime executes
  -> Human resolves uncertainty
```

This repository is being built for the Computer-Use Automation System take-home project. The current state is Phase 11 implemented: capabilities can be stability-validated across repeated replay runs and production invocation is gated to approved or active artifacts. Implementation progress is tracked in [status.md](status.md).

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
npm run demo:evidence
npm run demo:compile
npm run demo:discover
npm run demo:replay
npm run demo:not-found
npm run demo:recovery
npm run demo:slow
npm run demo:permission-denied
npm run demo:session-expired
npm run demo:app-error
npm run demo:handoff
npm run validate-capability -- member.get-savings-balance --runs 5
```

This path exercises the implemented discovery, compilation, deterministic replay, recovery, failure classification, same-session handoff, evidence, and validation demos.

Surface adapter debug:

```bash
npm run debug:surface
```

This starts a temporary demo app, launches Chromium through Playwright, locates the `Member Number` field, locates the `Search` button, navigates to member `12345`, locates the Savings balance cell inside the accounts iframe, and extracts `$3,182.46`.

Discovery:

```bash
npm run demo:discover -- --scripted
OPENAI_API_KEY=... npm run demo:discover -- --timeoutMs 120000
```

The scripted command verifies the same observe-decide-act loop locally without an API call. The live command uses the OpenAI Responses API adapter and requires `OPENAI_API_KEY`. Discovery decisions are schema-validated before policy checks and surface execution.

Discovery artifact compiler:

```bash
npm run demo:compile
npm run replay -- --capabilityPath capabilities/generated/member-get-savings-balance.draft.yaml --memberId 54321
```

The compiler turns a successful discovery trace into `capabilities/generated/member-get-savings-balance.draft.yaml`. The generated draft parameterizes the discovered member number as `memberId`, declares the normalized `balance` money output, keeps reviewable semantic targets, includes a checkpoint, and validates against the same artifact schema consumed by replay. The replay command above proves the generated artifact runs with `llmDecisionCalls: 0`.

Deterministic replay:

```bash
npm run replay -- --capability member.get-savings-balance --memberId 54321
npm run replay -- --capability member.get-savings-balance --memberId 00000 --port 3102
npm run replay -- --memberId 54321 --scenario interstitial --port 3111
npm run replay -- --memberId 54321 --scenario slow --port 3112
npm run replay -- --memberId 88888 --port 3113
npm run replay -- --memberId 54321 --scenario session-expired --port 3114
npm run replay -- --memberId 54321 --scenario error --port 3115
```

The first command replays the hand-authored capability against a different member and returns a normalized money output. The second command returns `business_outcome / MEMBER_NOT_FOUND`. The scenario commands demonstrate known interstitial recovery, slow-load recovery metadata, permission denial, session expiration, and app-error classification. All replay commands report `llmDecisionCalls: 0`.

Human handoff:

```bash
npm run demo:handoff
```

The handoff demo starts automation, triggers a session-expired condition, creates an intervention on the same browser session, transfers ownership to human, blocks automation while human owns the session, records redacted human input plus click/navigation actions, verifies the resume checkpoint, and continues automation to extract member `54321`'s savings balance. The output includes ownership transitions and `sameSessionRetained: true`.

Evidence:

```bash
npm run demo:evidence
```

This command regenerates curated JSONL evidence under `evidence/`:

```text
evidence/discovery-success/run.jsonl
evidence/replay-success/run.jsonl
evidence/replay-business-outcome/run.jsonl
evidence/replay-recovery/run.jsonl
evidence/replay-failure/run.jsonl
evidence/human-handoff/run.jsonl
evidence/artifacts/member-get-savings-balance.v1.yaml
```

The evidence captures model decisions, actual actions, policy checks, locator strategies, fallback use, recovery attempts, business outcomes, failure classes, checkpoint results, human actions, ownership transfer, automation resume, and `llmDecisionCalls: 0` for replay. Sensitive member IDs are redacted from JSONL.

Capability validation:

```bash
npm run validate-capability -- member.get-savings-balance --runs 5
```

The validation command replays the capability multiple times, reports success/failure counts plus primary/fallback locator usage, and stores a `validation` block on the artifact. A fully successful run is marked `eligible-for-approval`, but the artifact is not automatically approved. Production catalog invocation rejects `draft` capabilities and allows only `approved` or `active` artifacts.

## Safety

Replay actions pass through a structural policy layer before reaching the surface adapter. The current policy checks:

```text
allowed origins
allowed routes
allowed action types
risk class requiring human approval for irreversible writes
```

Inputs marked `sensitive: true` in a capability artifact are redacted from structured runtime output and log-like event payloads. Screenshots are not redacted yet; the intended production design is to associate sensitive inputs with target regions during fill/extract events and apply rectangular masking before screenshots are persisted.

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

Phase 1 tests validate that a well-formed capability artifact is accepted, malformed contracts are rejected, business outcomes are distinct from execution failures, and target descriptors do not leak Playwright selectors into the artifact schema. Phase 2 tests validate the local legacy banking proxy app and its deterministic runtime scenarios. Phase 3 tests validate the Playwright-backed surface adapter using semantic `TargetDescriptor` inputs. Phase 4 tests validate deterministic replay from a YAML capability artifact with no model credentials or LLM decision calls. Phase 5 tests validate runtime classification and bounded recovery behavior. Phase 6 tests validate policy enforcement and sensitive-data redaction. Phase 7 tests validate the discovery loop, decision schema, policy-blocked model actions, and verified goal completion. Phase 8 tests validate compiling a successful discovery trace into a redacted draft YAML artifact, schema-validating that generated artifact, and replaying it against member `54321` with no LLM decisions. Phase 9 tests validate same-session handoff, explicit ownership transfer, blocked automation during human control, redacted human action evidence, operator status, and resume verification. Phase 10 tests validate redacted evidence recording and replay evidence for policy checks, target resolution, actual actions, checkpoint success, and zero LLM calls. Phase 11 tests validate multi-run stability reporting and the production catalog approval gate.
