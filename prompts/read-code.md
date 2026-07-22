---
description: Build a compact codebase reading handoff without polluting parent context
argument-hint: "<question or scope>"
---

Launch `pi-shipyard.codebase-reader` with fresh context to investigate:

$@

Require a file-backed output with `outputMode: "file-only"`. The reader must inspect repository instructions, source, callers, tests, config, and current diff as relevant. Read only the resulting compact artifact needed to answer; do not import the child's full transcript into parent context.
