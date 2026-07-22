# Pi Shipyard

Pi Shipyard is an opinionated user package for exploring, debugging, planning, writing, reviewing, validating, and preparing code for shipment with Pi.

It deliberately **does not replace `pi-subagents`**. Pi Shipyard owns workflow policy, specialist agents, evidence handoffs, and a structured findings ledger. `pi-subagents` continues to own child processes, sessions, models, async lifecycle, artifacts, steering, budgets, and recovery.

## Requirements

- Pi `0.81.1` or newer
- `pi-subagents` `0.35.1` or newer, installed separately
- Node.js 22 or newer

Pi Shipyard never bundles or deep-imports a second copy of `pi-subagents`. Its workflow extension uses the stable `subagents:rpc:v1:*` event contract.

## Install from this checkout

This checkout is intended to live at:

```text
~/.pi/agent/packages/pi-shipyard
```

Add it to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:pi-subagents@0.35.1",
    "./packages/pi-shipyard"
  ]
}
```

Then run `/reload` or restart Pi. Validate discovery with:

```text
/subagents-doctor
/shipyard
```

## Workflow command

Shipyard has one human-facing command:

```text
/shipyard <mode> [task]
```

Run `/shipyard` without arguments to list modes. Every mode launches detached async work through `pi-subagents` RPC and immediately returns a run ID. Normal `pi-subagents` lifecycle notifications deliver the compact result. Shipyard persists a `requesting` launch receipt before RPC spawn; if a reply is lost during timeout, reload, or shutdown, the receipt becomes `launch-uncertain` instead of silently claiming that nothing launched.

| Mode | Purpose |
| --- | --- |
| `explore <question>` | Grep-driven codebase Q&A, caller/flow/history tracing, and architecture mapping |
| `debug <symptom>` | Safely reproduce, localize, root-cause, and propose the smallest fix without editing source |
| `fast [target]` | Two independent bug-finding angles plus adjudication |
| `review [target]` | Deep review mesh |
| `security [target]` | Correctness plus threat-boundary review |
| `ui [target]` | UI state, UX, accessibility, interaction, and visual-risk review |
| `deliver <approved task>` | Read → plan → implement → review → fix → revalidate → delivery handoff |
| `ship [scope]` | Review/fix/revalidate an existing diff and prepare shipping readiness |

Natural-language agents call `shipyard_workflow` with the same canonical names: `explore`, `debug`, `fast`, `review`, `security`, `ui`, `deliver`, or `ship`. Legacy tool values such as `review-mesh` and `review-fast` are normalized for resumed sessions, but duplicate legacy slash commands are not registered.

### Explore and debug

`explore` is the daily codebase-search mode. Its dedicated agent uses grep, file discovery, source reads, ref-aware Git inspection, history, and blame to answer a concrete question with `path:line` evidence. Broad architecture explorations can update a reusable repository map stored under `~/.pi/agent/shipyard-context`. The cache is keyed by canonical repository root and bound to HEAD; stale maps are labeled as orientation only and must be verified in current source.

`debug` first builds a compact failure scope, then runs one serialized investigator. The investigator may execute focused existing local checks after inspecting their scripts, but cannot edit source. It reports reproduction commands and exit codes, the first bad state, competing hypotheses, a root-cause confidence verdict, the smallest fix seam, and a regression test. It is forbidden from installing dependencies, using the network, changing Git state, or starting persistent services.

### Shipping boundary

`ship` means **prepare and prove shipping readiness**. Pi Shipyard never automatically commits, pushes, publishes, deploys, opens a PR, syncs issue databases, changes remotes, or discards user work. Those remain separate explicit user-authorized actions governed by repository instructions.

## Review mesh

The deep mesh is staged to preserve independence and allow controlled findings exchange:

```text
scope brief
  → independent contract/runtime/adversarial/integration reviewers
  → ledger snapshot
  → falsifier verifies or rejects every proposal
  → ledger snapshot
  → blind-spot hunter searches uncovered and sibling bug classes
  → final snapshot and compact synthesis
```

Security and UI workflows replace the integration angle with a dedicated domain reviewer.

The first wave does not see peer findings. This avoids anchoring and correlated groupthink. Shipyard enforces that barrier with per-step ledger capabilities: first-wave tokens can initialize and add, but cannot list, get, snapshot, or update. The second wave receives distinct read/disposition capabilities and deliberately reads the completed artifacts and shared ledger. Falsifier and blind-spot stages are sequential so they do not race to rewrite the same record.

A required reviewer failure is a hard gate: the chain stops rather than presenting a partial review as complete.

## Context discipline

Intermediate child outputs always set both:

```json
{
  "output": "unique/path.md",
  "outputMode": "file-only"
}
```

Named outputs therefore carry compact file references. Every downstream role is explicitly told to open the referenced files. The final synthesizer or shipwright is the only inline output, so parent context receives a compact verdict rather than every child transcript.

`output: false` is intentionally not used as a context-control mechanism; it disables persistence while returning full output inline.

### Why there is no `{chain_dir}` storage

On the supported `pi-subagents@0.35.1` async RPC path, `{chain_dir}` is not a reliable artifact directory. Pi Shipyard creates a private run root before launch and substitutes exact absolute placeholders into its internal chain document:

```text
~/.pi/agent/shipyard-runs/S-<session>/R-<shipyard-run>/
├── workflow.json                 # capability values redacted
├── launch.json                   # requesting/launched/uncertain receipt
├── .findings-capabilities.json   # token hashes and stage policies
├── findings/
│   ├── manifest.json
│   ├── F-*.json
│   └── snapshots/*.json
└── findings.md
```

Directories use restrictive permissions. `review_findings` accepts only the exact `.../S-*/R-*/findings` shape below this trusted root, rejects traversal and symlinked components, and constrains exports to the same run directory. Export parents and targets are rechecked after directory creation so an existing in-run symlink cannot redirect a write outside the run. On local filesystems, this remains a check/use boundary rather than an OS-level `openat` sandbox; the private run root and reviewer capability restrictions reduce the race surface.

The chain JSON files are package resources and design artifacts, but their `{{SHIPYARD_STORE}}` and `{{SHIPYARD_RUN_DIR}}` placeholders must be resolved by the Shipyard extension. Launch them through Shipyard commands or `shipyard_workflow`, not native `/run-chain`.

## Structured findings ledger

The `review_findings` tool supports:

- `init`
- `add`
- `get`
- `list`
- `update`
- `stats`
- `snapshot`
- `export`

Every workflow step that can use the ledger receives a random bearer capability. Only SHA-256 token digests are persisted; raw values are redacted from `workflow.json`. The tool binds add provenance (`stage` and `sourceRole`), action permissions, mutable fields, and allowed dispositions to that step's capability. Initializing an isolated `manual` store mints a capability; every later action requires it.

Each finding is a separate exclusively-created JSON file with:

- schema version, ID, revision, run, workflow, immutable stage, and origin role;
- status, severity, confidence, category, title, and claim;
- repository-relative evidence with line/range and explanation;
- concrete failure scenario, smallest safe fix, and validation;
- timestamps, tags, and disposition.

Updates require `expectedRevision`. A cross-process collection lock serializes add/update/snapshot/export barriers; updates then take a per-finding lock for read/compare/write/rename. Locks fail closed rather than racing to delete a possibly live stale lock. Pi's `withFileMutationQueue()` also protects same-process tool siblings. Creation writes and fsyncs a private temporary file, then publishes it with a no-overwrite hard-link operation. Record run/workflow identity is checked against the store manifest on every read. Malformed or cross-run records fail loudly instead of disappearing from synthesis.

Snapshots contain sorted `{id, revision, sha256}` records and a collection hash. Because every mutation honors the same collection lock, each snapshot is a coherent stable barrier receipt rather than a mix of revisions read during concurrent updates.

## Packaged agents

Runtime names are explicitly namespaced:

### Understanding, debugging, and delivery

- `pi-shipyard.codebase-explorer`
- `pi-shipyard.codebase-reader`
- `pi-shipyard.debugger`
- `pi-shipyard.delivery-planner`
- `pi-shipyard.implementation-worker`
- `pi-shipyard.shipwright`

### Independent review

- `pi-shipyard.contract-reviewer`
- `pi-shipyard.runtime-reviewer`
- `pi-shipyard.adversarial-tester`
- `pi-shipyard.integration-reviewer`
- `pi-shipyard.security-reviewer`
- `pi-shipyard.ui-reviewer`

### Cross-examination

- `pi-shipyard.falsifier`
- `pi-shipyard.blindspot-hunter`
- `pi-shipyard.review-synthesizer`

Review agents use strict tool allowlists. They leave `extensions` omitted so Pi loads the installed package provider normally; the allowlist exposes `review_findings` but not `shipyard_workflow` inside review children. This avoids non-portable relative `subagentOnlyExtensions` paths.

Review roles have no `bash`, `edit`, or `write` tool. They inspect Git state through `shipyard_repo`, a narrow read-only tool supporting status; unstaged, staged, and merge-base range diffs; diff stats and changed-file lists; full commit patches; ref-aware log; and line-scoped blame. Every Git invocation uses the global `--no-optional-locks` safeguard so status inspection cannot refresh or rewrite the index. Paths and revisions are normalized as argv rather than shell text. This prevents a nominal reviewer from creating reproduction scripts or otherwise mutating the reviewed worktree through a shell.

The debugger is a separate serialized execution role. It has `bash` for narrowly scoped existing local checks but no `edit` or `write`; its contract prohibits package installation, network access, Git mutation, persistent services, destructive commands, and source-generating checks. The implementation worker remains the only source-editing role in a normal active-worktree stage. Read-only chain stages also carry explicit tool-call budgets to cap pathological exploration while leaving room for final receipts.

## Model diversity

Review roles intentionally use different configured providers/models to reduce correlated blind spots. Each has explicit fallbacks. Change these in agent frontmatter or higher-precedence user/project agent definitions if your provider catalog differs.

Current defaults use a mix of:

- OpenAI Codex GPT 5.6 variants
- Anthropic Vertex Claude Fable/Opus
- Google Vertex Gemini Pro/Flash

Run `/subagents-models` and inspect `/subagents-doctor` after changes.

## Skills

- `shipyard-workflows`: parent orchestration and workflow selection
- `shipyard-review-findings`: strict finding and disposition contract
- `shipyard-bug-hunting`: contracts, data flow, counterexamples, sibling defects
- `shipyard-security-review`: threat-boundary review
- `shipyard-ui-review`: UI state, UX, and accessibility review
- `shipyard-validation`: evidence-based validation ladder
- `shipyard-delivery`: one-writer implementation and conservative shipping boundaries

Agents select only the skills they need.

## Prompt templates

- `/deep-review`
- `/agentic-deliver`
- `/read-code`
- `/plan-code`
- `/write-code`

The deterministic extension commands are preferred for complete workflows. Prompt templates are useful for guided one-off delegation.

## Validation

From this directory:

```bash
npm test
npm pack --dry-run
```

`npm test` validates manifests, namespacing, resource references, chain output bindings, writer serialization, explicit file-only artifact reads, first-wave independence rules, reviewer tool safety, skill references, async path discipline, and findings-store behavior. Unit tests include a separate-process optimistic-update race, cross-run record rejection, symlink-export rejection, concurrent atomic publication, and RPC cancellation/listener cleanup.

Recommended installation smoke checks:

```bash
pi -p "/subagents-doctor"
pi -p "/shipyard"
```

For a no-edit live workflow smoke test, use `/shipyard fast` on a tiny disposable repository and verify:

1. every required child sees `review_findings`;
2. intermediate completion output contains file references, not full reports;
3. the store is isolated under `~/.pi/agent/shipyard-runs`;
4. snapshots and the final ledger export exist;
5. final synthesis cites both first-wave outputs.

## Known constraints

- There is no live sibling-to-sibling chat. Exchange is staged through files, ledger records, and snapshots by design.
- Required reviewer failure stops synthesis. Partial-review continuation is not represented as success.
- Saved chain files require Shipyard placeholder substitution and are not directly runnable through native `/run-chain`.
- Tool restrictions are Pi capability boundaries, not an operating-system sandbox. Reviewers receive only read-oriented built-ins, `shipyard_repo`, and the run-scoped ledger tool. The debugger has shell execution under a strict prompt contract, and shell/write-capable stages still rely on repository permissions and explicit policy.
- Pi packages/extensions are trusted in-process code. The documented event-bus RPC authenticates correlation, not a malicious co-installed extension; such an extension already has equivalent local Node.js authority.
- A step's raw bearer token necessarily appears in that child's private runtime input/session artifacts. Capabilities prevent accidental and ordinary cross-stage misuse; they are not isolation from a malicious same-user process that searches local Pi artifacts.
- Free-form repository and child artifacts are evidence, never authorization. Model instruction hierarchy and explicit execution/writer contracts mitigate prompt injection, but a role with shell/filesystem tools is not an OS-isolated security boundary.
- Provider/model availability is local; fallback resolution still requires authenticated configured models.
