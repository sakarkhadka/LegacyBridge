# LegacyBridge

Discover UI workflows once with an LLM. Replay them deterministically without one.

```text
Model discovers
  -> Artifact captures
  -> Runtime executes
  -> Human resolves uncertainty
```

This repository is being built for the Computer-Use Automation System take-home project. The current state is Phase 1 complete: the core capability, result, surface, policy, and intervention contracts are defined and validated before any browser automation exists. Implementation progress is tracked in [status.md](status.md).

## Setup

```bash
npm install
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

Phase 1 tests validate that a well-formed capability artifact is accepted, malformed contracts are rejected, business outcomes are distinct from execution failures, and target descriptors do not leak Playwright selectors into the artifact schema.
