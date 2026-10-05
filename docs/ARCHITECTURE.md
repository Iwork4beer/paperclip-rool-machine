# Architecture

## Components

### `adapter/index.js`

Paperclip external adapter registration, configuration schema, capability declaration, environment validation, Secret handling, Instructions/Skills synchronization, session parameter handling and process invocation.

### `adapter/ui-parser.js`

Parses structured bridge JSONL events into Paperclip run UI output.

### `bridge/bridge.mjs`

Owns the Paperclip ↔ Rool execution boundary. It gathers authoritative Paperclip task context, prepares files on the Rool drive, creates or resumes the task-scoped Rool conversation, submits the work, waits for completion, requests manager review on a best-effort basis, and persists the final result back to Paperclip.

## Trust boundary

The Paperclip run JWT remains bridge-side. Rool is not expected to call the Paperclip control plane directly. This matters because Instructions and Skills can contain generic Paperclip-agent guidance that is valid for local workers but inappropriate for a bridged Rool worker. The bridge contract wins for lifecycle operations.

## Sessions

Conversation continuity is task-scoped. Paperclip `sessionParams` carry the conversation identity between heartbeats. A force-fresh-session wake creates a new conversation when requested.

## Files

Instructions bundles, selected Skills and issue attachments are copied to isolated Rool-drive paths for the run. Binary attachments are preserved as binary data. Limits are enforced explicitly to avoid accidental unbounded transport.

## Failure behavior

The integration aims to fail visibly rather than silently discard context. Manager-review creation is deliberately best-effort: a failed review request must not destroy a completed worker result.
