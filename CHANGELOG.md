# Changelog

## 0.2.1 — 2026-10-11

- Fixed managed Instructions startup failure when Paperclip materializes the entry file into a per-run directory but leaves `instructionsRootPath` pointing at the canonical bundle.
- The adapter now rebases only managed materialized bundles to a narrow root derived from the validated `instructionsEntryFile`.
- Preserved containment enforcement for external bundles and added regression coverage for flat/nested materialization, traversal, unrelated outside paths, and sibling-prefix escapes.
- Bridge 0.4.0 and Rool machine/profile bindings are unchanged.

## 0.2.0 — 2026-10-05

- First community release.
- Added full `rool_machine` external adapter integration.
- Added managed Instructions and Paperclip Skills transport.
- Added task-scoped session continuity, same-run retry idempotency and force-fresh sessions.
- Added issue attachment transport and rich Paperclip task context.
- Added structured run UI parsing and real Test Environment probing.
- Added Paperclip Secrets support for Rool credentials.
- Added bridge-owned checkout, manager-review request and final result persistence.
- Added explicit transport limits and regression integration tests.
