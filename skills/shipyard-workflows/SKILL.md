---
name: shipyard-workflows
description: Orchestrate Pi code work through Shipyard's deterministic read, plan, write, review, fix, validate, and ship workflows. Use when the user asks for deep review, agentic delivery, implementation-to-shipping, or the Shipyard workflow family.
---

# Shipyard workflows

Shipyard layers opinionated workflows on `pi-subagents`; it does not replace the subagent runtime.

## Preferred entry points

For natural-language orchestration, call `shipyard_workflow`:

- `review-fast`: two independent bug-finding angles followed by compact synthesis;
- `review-mesh`: scope mapping, four independent reviewers, falsifier, blind-spot hunter, and synthesis;
- `review-security`: the review mesh with a dedicated security boundary reviewer;
- `deliver`: read, plan, implement, review, fix, revalidate, and prepare a shipping handoff;
- `ship`: review and fix an existing diff, revalidate, and prepare a shipping handoff.

Humans can invoke the corresponding slash commands: `/review-fast`, `/parallel-review`, `/review-security`, `/deliver`, and `/ship`.

## Context discipline

- Intermediate review outputs use `outputMode: "file-only"`.
- Review findings live in a private, extension-created run directory; never use `{chain_dir}` as an async artifact path.
- Workflow placeholders are resolved before pi-subagents RPC launch, so children receive exact absolute store paths.
- Only the final synthesis or shipping receipt returns inline.
- Read detailed artifacts only when needed to verify or act on a specific claim.
- Do not substitute `output: false`; it disables persistence but still returns full child output inline.

## Review independence

The first review wave stays independent to avoid anchoring. A second wave deliberately shares findings:

1. falsifier snapshots the first-wave ledger, then verifies or rejects proposed findings;
2. blind-spot hunter runs after falsification, snapshots that state, then searches uncovered risk classes and sibling defects;
3. synthesizer snapshots the final discovery state and adjudicates a compact report.

Do not enable unstructured live peer discussion as a replacement for this staged exchange.

## Workflow selection

- Use `review-fast` for small, isolated, low-risk changes.
- Use `review-mesh` for normal features, bug fixes, refactors, or broad diffs.
- Use `review-security` whenever trust boundaries, auth, commands, secrets, privileged operations, or untrusted input are involved.
- Use `deliver` when implementation is authorized and should proceed end to end.
- Use `ship` when code already exists and needs review/fix/validation before handoff.

Reviewer failure is a hard gate: the chain does not synthesize a partial review when a required reviewer fails. All writer workflows retain one active-worktree writer. Shipyard never commits, pushes, publishes, deploys, or opens a PR automatically.
