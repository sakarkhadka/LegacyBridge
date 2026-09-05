# LegacyBridge

Discover UI workflows once with an LLM. Replay them deterministically without one.

```text
Model discovers
  -> Artifact captures
  -> Runtime executes
  -> Human resolves uncertainty
```

LegacyBridge is a focused end-to-end computer-use automation system for legacy bank/credit-union back-office UIs. It demonstrates a real LLM-driven discovery run, compiles the learned flow into a typed capability artifact, replays that artifact without LLM decisions, handles business outcomes and runtime failures, routes same-session human handoff, enforces policy, redacts sensitive data, and exposes an agent-facing capability catalog.

## Overview

The target app is a local legacy-style servicing console named `Heritage Core Servicing`. It intentionally uses server-rendered pages, generated IDs, duplicate button labels, table layouts, and an accounts iframe so replay cannot depend on clean test IDs.

The primary capability is:

```text
member.get-savings-balance(memberId) -> balance
```

Synthetic demo data:

```text
12345 -> $3,182.46
54321 -> $8,044.19
00000 -> MEMBER_NOT_FOUND
88888 -> PERMISSION_DENIED
```

## Architecture

```text
Natural-language goal
  -> Discovery agent
  -> Typed model decisions
  -> PolicyEngine
  -> SurfaceAdapter
  -> Discovery trace
  -> Artifact compiler
  -> Capability YAML
  -> ReplayEngine
  -> Typed result
```

Replay does not call the model. It executes ordered artifact steps through the same `SurfaceAdapter` contract used by discovery.

```text
ReplayEngine
  -> SurfaceAdapter
     -> PlaywrightSurfaceAdapter
     -> future DesktopAccessibilityAdapter
     -> future VisionCoordinateAdapter
```

## Why Split It

The model is useful for figuring out a UI once; the reusable capability must be typed, reviewable, parameterized, and cheap to run. LegacyBridge keeps that boundary explicit:

- Discovery accepts a goal and produces a trace.
- The compiler produces a YAML artifact, not a raw transcript.
- Replay consumes the artifact and returns `success`, `business_outcome`, or `failure`.
- Policy and redaction run outside the prompt, so they protect both discovery and replay.

## 2-Minute Demo

Install once:

```bash
npm install
npx playwright install chromium
```

Run the main no-cost path:

```bash
npm run demo:compile
npm run replay -- --capabilityPath capabilities/generated/member-get-savings-balance.draft.yaml --memberId 54321
npm run demo:not-found
npm run demo:recovery
npm run demo:handoff
npm run demo:catalog
```

Run the full verification suite:

```bash
npm run typecheck
npm test
npm audit --omit=optional
```

## Live LLM Discovery

The repository includes live LLM discovery evidence at:

```text
evidence/discovery-live/run.jsonl
```

To run your own live discovery, create `.env` from `.env.example` and set `OPENAI_API_KEY`. In Git Bash:

```bash
set -a; source .env; set +a; npm run demo:discover -- --model gpt-5-mini --maxSteps 6 --timeoutMs 120000 --evidencePath evidence/discovery-live/run.jsonl
```

For a free deterministic check of the same observe-decide-act loop:

```bash
npm run demo:discover -- --scripted
```

## Generated Capability

Compile a successful discovery trace into a draft artifact:

```bash
npm run demo:compile
```

Generated output:

```text
capabilities/generated/member-get-savings-balance.draft.yaml
```

The generated artifact parameterizes the discovered member number as `memberId`, declares `balance` as a money output, contains ordered semantic steps, includes a checkpoint, and validates under the same schema replay consumes. It does not contain the discovery literal `12345`.

The hand-authored reviewed artifact is:

```text
capabilities/member-get-savings-balance.v1.yaml
```

## Replay

Replay with a different member and zero LLM decision calls:

```bash
npm run replay -- --capability member.get-savings-balance --memberId 54321
```

Expected output includes:

```json
{
  "result": {
    "status": "success",
    "outputs": {
      "balance": {
        "type": "money",
        "value": {
          "amount": 8044.19,
          "currency": "USD"
        }
      }
    }
  },
  "llmDecisionCalls": 0
}
```

## Error Behavior

Business outcome:

```bash
npm run demo:not-found
```

Recoverable runtime condition:

```bash
npm run demo:recovery
```

Hard runtime failures:

```bash
npm run demo:permission-denied
npm run demo:session-expired
npm run demo:app-error
```

Replay distinguishes expected business outcomes from recoverable conditions and hard failures. Failure results include the step, expected condition, observed state, and whether recovery is available.

## Human Handoff

```bash
npm run demo:handoff
```

The demo starts automation, hits a session-expired condition, creates an intervention with screenshot context, transfers the same browser session to human ownership, blocks automation while the human owns the session, records redacted human input plus click/navigation actions, verifies the resume checkpoint, and continues automation in the original session.

## Safety

Guardrails are structural, not prompt-only:

- allowed origins
- allowed routes
- allowed action types
- risk classification
- human approval requirement for irreversible actions
- redaction of sensitive inputs in artifacts, logs, and structured results

The risky-action demo surface exists in the local app (`Open Sub Account` -> `Review` -> `Confirm Opening`) so the policy layer has a concrete irreversible action to classify. Production catalog invocation rejects `draft` capabilities and allows only `approved` or `active` artifacts.

## Evidence

Regenerate curated no-cost evidence:

```bash
npm run demo:evidence
```

Evidence files:

```text
evidence/discovery-live/run.jsonl
evidence/discovery-success/run.jsonl
evidence/replay-success/run.jsonl
evidence/replay-business-outcome/run.jsonl
evidence/replay-recovery/run.jsonl
evidence/replay-failure/run.jsonl
evidence/human-handoff/run.jsonl
evidence/artifacts/member-get-savings-balance.v1.yaml
```

The JSONL logs show model decisions, observations, policy checks, locator strategy used, fallback use, actions, recovery attempts, checkpoint pass/fail, business outcomes, failures, human actions, ownership transfer, automation resume, and `llmDecisionCalls: 0` for replay. Synthetic member IDs are redacted.

## Capability Validation

```bash
npm run validate-capability -- member.get-savings-balance --runs 5
```

This replays the artifact multiple times, reports success/failure counts and primary/fallback locator usage, and stores a `validation` block. A perfect run reports `eligible-for-approval`; it does not automatically approve the artifact.

## Agent Catalog

```bash
npm run demo:catalog
```

The catalog exposes:

```http
GET /capabilities
POST /capabilities/member.get-savings-balance/invoke
```

The public manifest includes only `name`, `description`, `inputs`, `outputs`, and `risk`. Calling agents provide business inputs like `{ "memberId": "54321" }`; they do not need to know Playwright, selectors, iframes, coordinates, pages, or DOM structure.

## Tests

```bash
npm run typecheck
npm test
```

Current suite covers artifact validation, demo app behavior, surface targeting, deterministic replay, recovery/failure classification, policy/redaction, discovery, artifact compilation, handoff, evidence, validation/approval, and catalog invocation.

## Project Structure

```text
src/artifact       Capability types, schemas, validation, serialization
src/catalog        Production approval gate and agent-facing catalog
src/cli            Local commands and demos
src/discovery      LLM observe/decide/act loop and artifact compiler
src/evidence       JSONL event contracts and recorders
src/intervention   Same-session human handoff state and operator seam
src/policy         Allowlists, risk classification, redaction
src/replay         Deterministic capability execution path
src/surface        Surface abstraction and Playwright adapter
demo-app           Local legacy banking proxy target
capabilities       Saved and generated capability artifacts
evidence           Curated reviewer evidence
tests              Focused architectural and runtime tests
```

## Scope

Implemented deeply: one live UI surface, one core read-only capability, artifact compilation, replay, runtime errors, policy, evidence, handoff, validation, and catalog invocation.

Deliberately not implemented: real bank integrations, production authentication, desktop automation, distributed workers, queues, persistent multi-tenant storage, and a full co-browsing console. The seams are present for these, but the assignment values the core automation abstraction over infrastructure breadth.
