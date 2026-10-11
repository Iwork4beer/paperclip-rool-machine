# v0.2.1 — managed Instructions materialization fix

Patch release for a verified startup failure in v0.2.0:

```text
Managed Instructions entry file is outside instructionsRootPath.
```

## Root cause

During a managed run, Paperclip can materialize the Instructions bundle into a per-run directory and replace `instructionsFilePath` with the materialized entry path while `instructionsRootPath` still points at the canonical managed bundle. v0.2.0 copied that mismatched pair into the bridge runtime manifest. The bridge correctly rejected it as an entry outside its declared root.

## Fix

The adapter now resolves the Instructions pair before writing the runtime manifest:

- if the entry is already contained by the configured root, behavior is unchanged;
- for `managed` bundles only, an entry outside the canonical root is treated as a materialized copy and the root is narrowly derived from the validated relative `instructionsEntryFile`;
- nested entry files are supported without collapsing the root to the nested entry directory;
- `external` bundles are never automatically rebased;
- traversal, unrelated outside paths, and sibling-prefix escapes remain rejected;
- the bridge's own root/entry containment check remains in place.

No Rool machine IDs, profiles, labels, credentials, session behavior, task lifecycle behavior, or bridge protocol were changed. Bridge version remains 0.4.0.

## Regression coverage

`npm run verify` now includes tests for:

- flat managed per-run materialization;
- nested managed entry materialization;
- traversal rejection;
- managed outside-path suffix mismatch rejection;
- external outside-root rejection;
- sibling-prefix escape rejection;
- the existing full mock Paperclip → Rool integration using a deliberately stale canonical `instructionsRootPath` and a materialized `instructionsFilePath`.

## Upgrade

Install `paperclip-rool-machine-v0.2.1.zip` over the existing v0.2.0 deployment with `install.sh`, restart Paperclip, then rerun the Rool onboarding task that previously failed at startup.
