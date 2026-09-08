# REPORT

## 1. Architecture

Decision: LegacyBridge separates discovery from production replay. Discovery accepts a natural-language goal, asks an LLM for typed actions, validates those actions, enforces policy, and drives a live UI through `SurfaceAdapter`. Replay accepts a saved capability artifact and inputs, then executes deterministic steps without LLM decisions.

Why: This matches the record-once / replay-many model in the assignment. The LLM is useful for finding the workflow once, but production invocation should be cheap, reviewable, and predictable.

Trade-off: The implementation has more explicit contracts than a quick Playwright script. That extra structure pays off because policy, evidence, handoff, validation, and catalog invocation all reuse the same artifact and runtime boundaries.

## 2. Artifact schema

Decision: The capability artifact is a YAML document with identity, version, lifecycle status, application fingerprint, typed inputs, typed outputs, business outcomes, ordered steps, semantic target descriptors, waits, recovery metadata, checkpoint, policy, and optional validation metadata.

Why: A calling agent and a human operator should understand what the capability does without reading browser code. Inputs such as `memberId` are parameterized and marked sensitive. Outputs such as `accountBalances` are typed as structured account balance rows. Targets use semantic strategies like label, accessible role, relative position, and structural table lookup rather than raw selectors.

Trade-off: The artifact schema is narrower than a universal RPA model. It intentionally supports the locators and actions needed for this vertical slice while leaving extension points for desktop accessibility or vision-coordinate adapters.

## 3. Determinism & error handling

Decision: Replay runs the artifact step by step through `ReplayEngine`, resolves each target deterministically, waits for declared conditions, parses declared outputs, and verifies the checkpoint before returning success. Replay reports `llmDecisionCalls: 0`.

Why: Production agents should not re-reason about stable enterprise UIs on every call. The important runtime complexity is not constant UI drift; it is operational conditions such as not found, permission denied, session expiration, interstitials, slow loads, and app errors.

Trade-off: Known recoveries are explicit and bounded. For example, the replay engine can dismiss a known system notice and retry slow loads, but it does not improvise through unknown states. Unknown or hard conditions become structured failures with step id, expected state, observed state, and recoverability.

## 4. Heterogeneity & multi-tenant

Decision: Browser automation is implemented with Playwright, but core contracts depend on `SurfaceAdapter`, not Playwright. The artifact records target identity; the adapter decides how to perceive and act on a specific surface. The implementation now includes a second Riverside tenant app with a different route, login form, page language, and table structure to show the same business capability running through a tenant-specific artifact.

Why: The real environment includes modern web, legacy web, and desktop apps. A future `DesktopAccessibilityAdapter` could resolve accessible roles and labels from OS accessibility APIs. A future `VisionCoordinateAdapter` could resolve the same target description through screenshots and coordinates.

Trade-off: Desktop and multi-tenant storage are not implemented. The design story is encoded through application profiles, application fingerprints, compatibility metadata, semantic targets, and tenant-specific artifact mappings. Significant drift should trigger revalidation rather than silent improvisation.

## 5. Escalation & handoff

Decision: Human handoff uses an explicit control state machine: automation owns the session, automation pauses, a human owns the same live browser session, the human acts, resume is requested, a checkpoint is verified, and automation owns the session again.

Why: The assignment specifically rejects handoff by opening a new browser. The intervention request carries run id, capability id, step id, reason, current route, screenshot reference, last actions, owner, and timestamp. Human click, input, and navigation actions are recorded as evidence.

Trade-off: The operator surface is intentionally minimal. The demo drives the human action with Playwright for repeatability, but the ownership model, evidence, and same-session mechanics are real and can be observed headfully.

## 6. Safety

Decision: Policy is enforced structurally before surface execution. It checks allowed origins, routes, action types, risk classification, and human approval for irreversible actions. Sensitive inputs are redacted from artifacts, logs, evidence, and structured failures.

Why: Prompt instructions alone are not a safety boundary, especially for regulated financial workflows. Replay and discovery both pass through the same policy and redaction seams.

Trade-off: This is not production compliance tooling. It does not implement real authentication, tenant secrets, screenshot-region masking, or audit retention policy. It demonstrates the core guardrail model and documents the limits.

## 7. Cuts

Decision: The project focuses on a high-quality automation slice anchored by Heritage member servicing, then adds Riverside as a deliberately smaller second tenant to prove the onboarding shape against a different UI.

Why: The assignment rewards clear boundaries, correct replay semantics, error handling, safety, handoff, evidence, and extensibility more than infrastructure breadth. Heritage carries the richer behavior: account balances, transaction history, deposits, withdrawals, state mutation, approval, recovery, and handoff. Riverside stays intentionally minimal: a different login and account-balance surface mapped to the same `member.get-account-balances` contract through a tenant-specific artifact.

Trade-off: I did not build distributed orchestration, queues, a database-backed registry, real bank integrations, production auth, desktop automation, persistent tenant storage, artifact inheritance, or a full co-browsing console. With more time, I would add tenant override files, screenshot redaction masks tied to filled target regions, a small approval UI for promoting `validated` artifacts to `approved`, and more tenant variants that exercise deeper UI differences beyond account-balance lookup.

## 8. Production considerations

The demo target is intentionally local, but the runtime shape is meant to map to an actual bank or credit-union operations environment without putting credentials or browser mechanics inside every capability artifact.

In production, each financial institution would be represented as a tenant with its own target origins, application fingerprints, capability registry namespace, policy profile, evidence retention rules, and secret references. The repository now includes this idea as a lightweight profile file under `tenants/`. Artifacts would be versioned per tenant and application, for example `tenant-a.core.member.get-account-balances.v3`, because two institutions may run similar servicing platforms with small route, label, entitlement, or branding differences.

Authentication should remain outside the artifact. The demo uses `DemoFormAuthProvider`; a bank integration would swap in a tenant-specific `RuntimeAuthProvider` backed by SSO or privileged access infrastructure such as OIDC, SAML, Okta, Microsoft Entra ID, Ping, CyberArk, or a vault/KMS-backed credential broker. Runtime credentials, session cookies, refresh tokens, and MFA state would never be stored in YAML artifacts or evidence logs. The replay worker would authenticate into a controlled browser context, record that authentication succeeded with a redacted principal and role, then execute the deterministic capability.

Authorization should be enforced at two layers. First, the bank application still decides what the runtime user can see or change. Second, LegacyBridge policy checks the capability risk classification and runtime role before replay. A read-only operator can invoke balance and transaction-history capabilities, while a read/write operator can invoke mutating capabilities only when the artifact policy and approval state allow it. This double boundary matters because UI automation should not turn a broad service account into an unreviewed transaction channel.

Human approval and handoff would use the same ownership model demonstrated here: automation owns the live browser session, pauses at a risky or ambiguous point, presents the current state to an authorized operator, records the operator decision, verifies a checkpoint, and resumes in the same session. For a real bank, the operator surface would sit behind enterprise auth, approval decisions would be tied to named users and ticket IDs, and the evidence stream would be immutable and encrypted with tenant-specific retention.

Operationally, production would add a worker queue, browser context isolation per run, per-tenant rate limits, health checks, alerting, replay timeouts, and circuit breakers for repeated failures. Screenshots and DOM snapshots would need field-level redaction rules. Capability promotion would move through draft, validation, approval, and active stages, with replay metrics used to detect UI drift. When drift appears, discovery can regenerate a draft, but production replay should fail closed until a validated artifact is promoted.

This project does not claim those production services are complete. It demonstrates the important seams: deterministic replay without LLM decisions, semantic artifacts, tenant/application profiles, runtime authentication outside the artifact, role-aware policy, same-session handoff, redacted evidence, and a catalog boundary that calling agents can use without knowing how the legacy UI works.
