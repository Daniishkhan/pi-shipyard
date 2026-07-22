# Pi Shipyard contributor instructions

## Architecture boundary

Pi Shipyard owns workflow policy, specialist roles, structured findings, and compact handoffs. It does not reimplement or deep-import pi-subagents runtime internals. Use only documented Pi APIs and the stable `subagents:rpc:v1:*` event contract.

## Invariants

- Keep one source writer per active-worktree stage.
- Keep first-wave reviewers independent.
- Exchange findings through the run-scoped ledger and file-only artifacts.
- Never use `{chain_dir}` as storage for async RPC workflows on the supported runtime.
- Every intermediate file-only step must set a unique `output` path and `as` name.
- Downstream tasks must explicitly open every referenced file-only output.
- Required reviewer failure is a hard gate; do not present a partial review as complete.
- Findings require evidence, a failure scenario, and a smallest safe fix.
- Findings provenance is immutable; updates require `expectedRevision`.
- Review roles do not receive `bash`, `edit`, or `write`; Git inspection goes through `shipyard_repo`.
- Shipyard never commits, pushes, publishes, deploys, or opens PRs automatically.

## Validation

Run before handoff:

```bash
npm test
npm pack --dry-run
```

After changing resources, run Pi discovery smoke checks and verify package agents/chains are reported by `/subagents-doctor`.
