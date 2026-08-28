# Carpo Agent Guidance

## Architecture before implementation

For every nontrivial feature or fix, do a lightweight architecture preflight before editing code:

1. Name the module that owns the behavior.
2. Define its smallest useful interface, including invariants, ordering constraints, error modes, and required configuration.
3. Keep domain rules in that module so routes, UI, Think, WebMCP, and background-process adapters do not duplicate them.
4. Introduce a seam only when behavior actually varies across at least two adapters. Keep a single implementation direct until then.
5. Make the interface the primary test surface. Accept dependencies and return inspectable results where practical.

Prefer deep modules: substantial behavior behind a small interface. Optimize for leverage for callers and locality for maintainers. Apply the deletion test before extracting a module: deleting a useful module should force its hidden complexity back into multiple callers rather than make the complexity disappear.

State the owning module, proposed interface, and relevant adapters in the implementation plan or first progress update. This is a short design commitment, not a separate review session. Trivial copy, styling, documentation, generated-file, and mechanical changes can skip it.

## Product decision cadence

Use roadmap issues #12, #13, and #14 as the calibration set. Before implementing each one, present a short decision brief containing only unresolved consequential choices. For each choice, give one recommendation and the strongest alternative with its tradeoff. The user may approve the brief as a whole or override individual recommendations. A full grilling session is not the default.

After the calibration set, apply established preferences autonomously. Request user judgment when a choice:

- changes the product's meaning or primary workflow;
- affects privacy, authorization, data ownership, or destructive behavior;
- creates expensive or difficult-to-reverse architecture, infrastructure, or vendor coupling;
- conflicts with a recorded decision;
- has multiple genuinely competitive user-experience directions; or
- requires fresh authority to merge, deploy, delete, publish, or contact an external party.

Proceed within the accepted issue scope without additional questions for reversible implementation choices covered by existing guidance. After issue #14, revise this section from the observed calibration results and remove rules that did not improve decisions.

## Delivery evidence

Treat deterministic tests as the authoritative release signal. Run Flue afterward as an advisory browser reviewer for exploratory coverage, screenshots, replay, diagnostics, and evidence-grounded friction. A Flue finding cannot turn a deterministic failure green. Report what the evidence proves, what remains uncertain, and any manual or hosted acceptance still required.

## During and after implementation

- Keep manual Carpo operation complete and correct; Think and WebMCP remain optional adapters to shared capabilities.
- Preserve one authoritative path for validation, authorization, idempotency, human review, and recoverable manual correction.
- Add tests through the module interface and use adapter-level tests only for adapter-specific behavior.
- Before finishing, check that callers learned less rather than more, domain rules remain local, and tests do not reach through the interface into implementation details.

Use normal targeted verification after this check. Invoke a full Improve Codebase Architecture or grilling session only when at least one of these signals is present:

- domain rules are duplicated across callers or adapters;
- tests must bypass the intended interface;
- callers must understand substantial implementation detail;
- a change introduces multiple real adapters or crosses several existing seams;
- consequential behavior has no clear owning module;
- repeated feature work is making the same area harder to change.

When none of these signals is present and verification is green, move on to product work.
