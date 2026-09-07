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

The primary read capability is:

```text
member.get-account-balances(memberId) -> accountBalances[]
```

The demo also includes account-number based write and history capabilities:

```text
member.deposit-to-account(memberId, accountNumber, amount) -> newBalance
member.withdraw-from-account(memberId, accountNumber, amount) -> newBalance
member.get-transaction-history(memberId, accountNumber) -> transactions[]
```

Synthetic demo data:

```text
12345 -> Savings $3,182.46; Checking $842.10
54321 -> Savings $8,044.19; Checking $12,000.00
00000 -> MEMBER_NOT_FOUND
88888 -> PERMISSION_DENIED
```

Manual demo and CLI runs share mutable demo state through `demo-app/state.json`. The file is created from the committed seed data on first use and is ignored by git.

The standalone demo app requires operator login. Seeded users are:

```text
read / r123 -> read-only access for balances and transactions
readwrite / rw123 -> read/write access for deposits, withdrawals, and sub-account opening
```

Replay, discovery, and compile commands authenticate as a runtime user before executing the capability. By default they use `readwrite/rw123`; override that with `--runtimeUser`, `--runtimePassword`, or the matching environment variables. Use `--auth none` only for explicit local unauthenticated experiments.

Reset local demo state:

```bash
npm run demo:reset-data
```

Start the demo app manually on port `3000`:

```bash
npm run demo-app
```

When passing CLI flags through an npm script, keep the extra `--` before the flags:

```bash
npm run replay -- --capability member.get-account-balances --memberId 54321
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
npm run replay -- --capabilityPath capabilities/generated/member-get-account-balances.draft.yaml --memberId 54321
npm run demo:not-found
npm run demo:recovery
npm run demo:handoff
npm run demo:catalog
```

Try the approval-gated write flows after resetting seed data:

Against an already-running app on port `3000`:

Immediate approval flag:

```bash
npm run demo:reset-data
npm run demo-app
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --approvalGranted --origin http://127.0.0.1:3000 --noDemoServer
npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --approvalGranted --origin http://127.0.0.1:3000 --noDemoServer
npm run replay -- --capability member.get-transaction-history --memberId 12345 --accountNumber S-100234 --origin http://127.0.0.1:3000 --noDemoServer
```

Browser approval handoff:

```bash
npm run demo:reset-data
npm run demo-app
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --origin http://127.0.0.1:3000 --noDemoServer --interactive --headed --approvalTtlSeconds 60
npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --origin http://127.0.0.1:3000 --noDemoServer --interactive --headed --approvalTtlSeconds 60
npm run replay -- --capability member.get-transaction-history --memberId 12345 --accountNumber S-100234 --origin http://127.0.0.1:3000 --noDemoServer
```

Or let each command start its own temporary demo app:

```bash
npm run demo:reset-data
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --approvalGranted
npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --approvalGranted
npm run replay -- --capability member.get-transaction-history --memberId 12345 --accountNumber S-100234
```

Without `--approvalGranted`, replay stops at the final confirmation click with `POLICY_VIOLATION`.

To demonstrate runtime user roles:

```bash
npm run replay -- --capability member.get-account-balances --memberId 54321 --runtimeUser read --runtimePassword r123
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --approvalGranted --runtimeUser read --runtimePassword r123
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --approvalGranted --runtimeUser readwrite --runtimePassword rw123
```

The first command succeeds, the second is blocked by runtime role policy, and the third is allowed to proceed to the normal write approval gate.

For a browser-driven approval window instead of a direct approval flag:

Against an already-running app:

```bash
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --origin http://127.0.0.1:3000 --noDemoServer --interactive --approvalTtlSeconds 60
npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --origin http://127.0.0.1:3000 --noDemoServer --interactive --approvalTtlSeconds 60
```

Or with the CLI-managed demo app:

```bash
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --interactive --approvalTtlSeconds 60
npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --interactive --approvalTtlSeconds 60
```

Open the printed approval URL and click `Approve Action` at the top of the page. If no one approves before the countdown ends, the operator server closes and replay remains unapproved.

The approval page shows the captured application screen from the actual replay session, outlines the risky confirmation control before the screenshot is taken, displays the countdown in the page, and includes a `Close` button for an explicit non-approval.

When running with `--headed`, the actual controlled app page also shows a LegacyBridge approval countdown banner. The operator can either approve from the printed approval URL or complete the highlighted confirmation directly in the visible app browser; replay detects that human-completed confirmation and resumes without waiting for the full TTL.

For visible same-session handoff, add `--headed`. This is a readable alias for `--headless false`:

Against an already-running app:

```bash
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --origin http://127.0.0.1:3000 --noDemoServer --interactive --headed --approvalTtlSeconds 60
npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --origin http://127.0.0.1:3000 --noDemoServer --interactive --headed --approvalTtlSeconds 60
```

Or with the CLI-managed demo app:

```bash
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --interactive --headed --approvalTtlSeconds 60
npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --interactive --headed --approvalTtlSeconds 60
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

Run discovery against an already-running app:

```bash
npm run demo-app
npm run demo:discover -- --scripted --origin http://127.0.0.1:3000 --noDemoServer
```

## Generated Capability

Compile a successful discovery trace into a draft artifact. Account balances are the default:

```bash
npm run demo:compile
```

Regenerate draft artifacts for all supported capabilities:

```bash
npm run demo:compile -- --capability member.get-account-balances
npm run demo:compile -- --capability member.deposit-to-account
npm run demo:compile -- --capability member.withdraw-from-account
npm run demo:compile -- --capability member.get-transaction-history
```

Compile against an already-running app:

```bash
npm run demo-app
npm run demo:compile -- --origin http://127.0.0.1:3000 --noDemoServer
npm run demo:compile -- --capability member.get-account-balances --origin http://127.0.0.1:3000 --noDemoServer
npm run demo:compile -- --capability member.deposit-to-account --origin http://127.0.0.1:3000 --noDemoServer
npm run demo:compile -- --capability member.withdraw-from-account --origin http://127.0.0.1:3000 --noDemoServer
npm run demo:compile -- --capability member.get-transaction-history --origin http://127.0.0.1:3000 --noDemoServer
```

Generated outputs:

```text
capabilities/generated/member-get-account-balances.draft.yaml
capabilities/generated/member-deposit-to-account.draft.yaml
capabilities/generated/member-withdraw-from-account.draft.yaml
capabilities/generated/member-get-transaction-history.draft.yaml
```

Generated artifacts parameterize discovered values such as `memberId`, `accountNumber`, and `amount`, declare structured outputs, contain ordered semantic steps, include checkpoints, and validate under the same schema replay consumes. They do not contain the discovery literal `12345` or discovered account numbers.

The hand-authored reviewed artifacts are:

```text
capabilities/member-get-account-balances.v1.yaml
capabilities/member-deposit-to-account.v1.yaml
capabilities/member-withdraw-from-account.v1.yaml
capabilities/member-get-transaction-history.v1.yaml
```

## Replay

Replay with a different member and zero LLM decision calls:

```bash
npm run replay -- --capability member.get-account-balances --memberId 54321
```

Replay against an already-running target app instead of letting the CLI start the bundled demo server:

```bash
npm run demo-app
npm run replay -- --capability member.get-account-balances --memberId 54321 --origin http://127.0.0.1:3000 --noDemoServer
```

`--origin` points automation at that base URL. `--noDemoServer` skips starting the synthetic demo app, which is the closer shape for production where the legacy application already exists.

Expected output includes:

```json
{
  "result": {
    "status": "success",
    "outputs": {
      "accountBalances": {
        "type": "accountBalances",
        "value": [
          {
            "accountType": "Savings",
            "balance": {
              "amount": 8044.19,
              "currency": "USD"
            }
          },
          {
            "accountType": "Checking",
            "balance": {
              "amount": 12000,
              "currency": "USD"
            }
          }
        ]
      }
    }
  },
  "llmDecisionCalls": 0
}
```

Run a mutating capability with explicit approval:

Against an already-running app:

Immediate approval flag:

```bash
npm run demo-app
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --approvalGranted --origin http://127.0.0.1:3000 --noDemoServer
npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --approvalGranted --origin http://127.0.0.1:3000 --noDemoServer
```

Browser approval handoff:

```bash
npm run demo-app
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --origin http://127.0.0.1:3000 --noDemoServer --interactive --headed --approvalTtlSeconds 60
npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --origin http://127.0.0.1:3000 --noDemoServer --interactive --headed --approvalTtlSeconds 60
```

Or with the CLI-managed demo app:

```bash
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --approvalGranted
npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --approvalGranted
```

Expected output includes `newBalance` as typed money. Because normal CLI runs use `demo-app/state.json`, a later account-balance replay on any port will reflect the updated balance until you run `npm run demo:reset-data`.

Fetch the latest ten account transactions:

```bash
npm run replay -- --capability member.get-transaction-history --memberId 12345 --accountNumber S-100234
```

Replay mutating and history capabilities against an already-running app:

Immediate approval flag:

```bash
npm run demo-app
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --approvalGranted --origin http://127.0.0.1:3000 --noDemoServer
npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --approvalGranted --origin http://127.0.0.1:3000 --noDemoServer
npm run replay -- --capability member.get-transaction-history --memberId 12345 --accountNumber S-100234 --origin http://127.0.0.1:3000 --noDemoServer
```

Browser approval handoff:

```bash
npm run demo-app
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --origin http://127.0.0.1:3000 --noDemoServer --interactive --headed --approvalTtlSeconds 60
npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --origin http://127.0.0.1:3000 --noDemoServer --interactive --headed --approvalTtlSeconds 60
npm run replay -- --capability member.get-transaction-history --memberId 12345 --accountNumber S-100234 --origin http://127.0.0.1:3000 --noDemoServer
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

For a reviewer-facing handoff page:

```bash
npm run demo:handoff -- --interactive --handoffTtlSeconds 60
```

Open the printed operator URL and click `Confirm Resume` at the top of the page. The command keeps the operator server alive until resume is confirmed or the countdown expires.

The handoff page shows the captured session-expired screen with the expected resume control highlighted, keeps the timer in the page, and closes as soon as resume/close/timeout is recorded.

For handoff against an already-running local target app with a visible Playwright browser:

```bash
npm run demo:handoff -- --origin http://127.0.0.1:3000 --noDemoServer --interactive --headed --handoffTtlSeconds 120
```

`--headed` opens the Playwright browser window. The equivalent long form is:

```bash
npm run demo:handoff -- --origin http://127.0.0.1:3000 --noDemoServer --interactive --headless false --handoffTtlSeconds 120
```

## Safety

Guardrails are structural, not prompt-only:

- allowed origins
- allowed routes
- allowed action types
- risk classification
- human approval requirement for irreversible actions
- redaction of sensitive inputs in artifacts, logs, and structured results
- bounded operator windows for interactive approval and handoff

The risky-action demo surface exists in the local app (`Open Sub Account` -> `Review` -> `Confirm Opening`) so the policy layer has a concrete irreversible action to classify. Confirming the flow creates a new sub-account in `demo-app/state.json`, so the account appears in the member's refreshed accounts list and in later replay runs on other ports. Production catalog invocation rejects `draft` capabilities and allows only `approved` or `active` artifacts.

Deposit and withdrawal replay demonstrate row-scoped write automation. The artifact selects the requested account row by exact `accountNumber`, clicks the matching `Deposit` or `Withdraw` control, fills the amount, reviews the projected balance, and only allows the final confirmation step when approval is granted. This keeps duplicate account types, such as two Savings accounts, from receiving the wrong transaction.

## Production Considerations

For a real bank website, the CLI-managed demo server would be replaced by an already-running institution URL passed with `--origin` and `--noDemoServer`. Runtime login would remain outside the capability artifact through a tenant-specific auth provider, while capability artifacts would stay focused on business steps, typed inputs, policy, checkpoints, and outputs.

A production deployment would add tenant-specific origin allowlists, capability registries, SSO or vault-backed runtime authentication, per-tenant browser isolation, encrypted evidence retention, approval audit trails, drift validation, worker queues, and operational monitoring. The current demo includes the seams for those concerns without turning the assignment into infrastructure scaffolding.

See [REPORT.md](./REPORT.md) for the fuller production and multi-tenant design notes.

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
evidence/artifacts/member-get-account-balances.v1.yaml
evidence/artifacts/member-deposit-to-account.v1.yaml
evidence/artifacts/member-withdraw-from-account.v1.yaml
evidence/artifacts/member-get-transaction-history.v1.yaml
```

The JSONL logs show model decisions, observations, policy checks, locator strategy used, fallback use, actions, recovery attempts, checkpoint pass/fail, business outcomes, failures, human actions, ownership transfer, automation resume, and `llmDecisionCalls: 0` for replay. Synthetic member IDs are redacted.

## Capability Validation

Validate read-only capabilities without changing demo state:

```bash
npm run validate-capability -- member.get-account-balances --runs 5
npm run validate-capability -- member.get-transaction-history --runs 5 --memberId 12345 --accountNumber S-100234
```

Validate approval-gated write capabilities against an isolated in-memory demo state:

```bash
npm run validate-capability -- member.deposit-to-account --runs 3 --memberId 12345 --accountNumber S-100234 --amount 1.00 --approvalGranted --ephemeralState
npm run validate-capability -- member.withdraw-from-account --runs 3 --memberId 12345 --accountNumber C-442910 --amount 1.00 --approvalGranted --ephemeralState
```

Validate against an already-running app:

```bash
npm run demo-app
npm run validate-capability -- member.get-account-balances --runs 5 --origin http://127.0.0.1:3000 --noDemoServer
npm run validate-capability -- member.get-transaction-history --runs 5 --memberId 12345 --accountNumber S-100234 --origin http://127.0.0.1:3000 --noDemoServer
npm run validate-capability -- member.deposit-to-account --runs 3 --memberId 12345 --accountNumber S-100234 --amount 1.00 --approvalGranted --origin http://127.0.0.1:3000 --noDemoServer
npm run validate-capability -- member.withdraw-from-account --runs 3 --memberId 12345 --accountNumber C-442910 --amount 1.00 --approvalGranted --origin http://127.0.0.1:3000 --noDemoServer
```

This replays the artifact multiple times, reports success/failure counts and primary/fallback locator usage, and stores a `validation` block. A perfect run reports `eligible-for-approval`; it does not automatically approve the artifact. Write validation uses the normal approval policy, so deposit and withdrawal validation require `--approvalGranted` or they correctly fail closed.

## Agent Catalog

```bash
npm run demo:catalog
```

Run the catalog against an already-running target app:

```bash
npm run demo-app
npm run demo:catalog -- --origin http://127.0.0.1:3000 --noDemoServer
```

The catalog exposes:

```http
GET /capabilities
POST /capabilities/member.get-account-balances/invoke
```

The public manifest includes only `name`, `description`, `inputs`, `outputs`, and `risk`. Calling agents provide business inputs like `{ "memberId": "54321" }`; they do not need to know Playwright, selectors, iframes, coordinates, pages, or DOM structure.

## Existing App Command Reference

Use these commands when the target website is already running, for example at `http://127.0.0.1:3000`.

The canonical CLI flag is `--noDemoServer`; lowercase `--nodemoserver` is also accepted as a convenience alias.

```bash
npm run demo-app
```

Read-only replay:

```bash
npm run replay -- --capability member.get-account-balances --memberId 54321 --origin http://127.0.0.1:3000 --noDemoServer
```

Transaction history replay:

```bash
npm run replay -- --capability member.get-transaction-history --memberId 12345 --accountNumber S-100234 --origin http://127.0.0.1:3000 --noDemoServer
```

Approved write replay:

```bash
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --approvalGranted --origin http://127.0.0.1:3000 --noDemoServer
npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --approvalGranted --origin http://127.0.0.1:3000 --noDemoServer
```

Interactive approval with visible Playwright browser:

```bash
npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --origin http://127.0.0.1:3000 --noDemoServer --interactive --headed --approvalTtlSeconds 60
npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --origin http://127.0.0.1:3000 --noDemoServer --interactive --headed --approvalTtlSeconds 60
```

Interactive handoff with visible Playwright browser:

```bash
npm run demo:handoff -- --origin http://127.0.0.1:3000 --noDemoServer --interactive --headed --handoffTtlSeconds 120
```

Discovery and compile:

```bash
npm run demo:discover -- --scripted --origin http://127.0.0.1:3000 --noDemoServer
npm run demo:compile -- --origin http://127.0.0.1:3000 --noDemoServer
npm run demo:compile -- --capability member.get-account-balances --origin http://127.0.0.1:3000 --noDemoServer
npm run demo:compile -- --capability member.deposit-to-account --origin http://127.0.0.1:3000 --noDemoServer
npm run demo:compile -- --capability member.withdraw-from-account --origin http://127.0.0.1:3000 --noDemoServer
npm run demo:compile -- --capability member.get-transaction-history --origin http://127.0.0.1:3000 --noDemoServer
```

Validation and catalog:

```bash
npm run validate-capability -- member.get-account-balances --runs 5 --origin http://127.0.0.1:3000 --noDemoServer
npm run validate-capability -- member.get-transaction-history --runs 5 --memberId 12345 --accountNumber S-100234 --origin http://127.0.0.1:3000 --noDemoServer
npm run validate-capability -- member.deposit-to-account --runs 3 --memberId 12345 --accountNumber S-100234 --amount 1.00 --approvalGranted --origin http://127.0.0.1:3000 --noDemoServer
npm run validate-capability -- member.withdraw-from-account --runs 3 --memberId 12345 --accountNumber C-442910 --amount 1.00 --approvalGranted --origin http://127.0.0.1:3000 --noDemoServer
npm run demo:catalog -- --origin http://127.0.0.1:3000 --noDemoServer
```

Use hidden/headless mode explicitly:

```bash
npm run replay -- --capability member.get-account-balances --memberId 54321 --origin http://127.0.0.1:3000 --noDemoServer --headless true
```

## Tests

```bash
npm run typecheck
npm test
```

Current suite covers artifact validation, demo app behavior, runtime auth, role-aware replay policy, surface targeting, deterministic replay, recovery/failure classification, policy/redaction, discovery, artifact compilation, handoff, evidence, validation/approval, and catalog invocation.

## Project Structure

```text
src/artifact       Capability types, schemas, validation, serialization
src/auth           Runtime authentication provider seam and demo form-login provider
src/catalog        Production approval gate and agent-facing catalog
src/cli            Local commands and demos
src/discovery      LLM observe/decide/act loop and artifact compiler
src/evidence       JSONL event contracts and recorders
src/intervention   Same-session human handoff state and operator seam
src/policy         Allowlists, risk classification, redaction
src/replay         Deterministic capability execution path
src/surface        Surface abstraction and Playwright adapter
demo-app           Local legacy banking proxy target and JSON-backed demo state
capabilities       Saved and generated capability artifacts
evidence           Curated reviewer evidence
tests              Focused architectural and runtime tests
```

## Scope

Implemented deeply: one live UI surface, a realistic JSON-backed servicing app, runtime login with read-only and read/write users, semantic capability artifacts, deterministic replay, account-balance lookup, account-number scoped deposits and withdrawals, transaction-history lookup, artifact compilation, capability validation, recovery and hard-failure paths, policy/redaction, same-session human approval and handoff, evidence capture, external-origin execution, headed/headless browser modes, and an agent-facing catalog.

Deliberately not implemented: real bank integrations, enterprise SSO/vault integration, desktop automation, distributed workers, queues, persistent multi-tenant storage, encrypted evidence retention, and a full production co-browsing console. The seams are present for these, while the implementation stays focused on the core automation abstraction and reviewer-runnable vertical slice.
