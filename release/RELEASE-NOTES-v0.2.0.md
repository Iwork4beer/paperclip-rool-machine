# v0.2.0 — first community release

This is the first public/community release of the unofficial Paperclip ↔ Rool Machine integration.

## Highlights

- external adapter type `rool_machine`
- managed Instructions bundles
- Paperclip Skills transport
- persistent task-scoped Rool sessions
- same-run retry idempotency and force-fresh-session support
- binary issue attachments
- rich issue/project/goal/comment/wake context
- real Test Environment probe
- structured Paperclip run UI events
- Paperclip Secrets support for Rool credentials
- bridge-owned checkout, manager-review request and result persistence
- explicit transport limits

## Validation

Before packaging:

- JavaScript syntax checks passed for adapter, UI parser and bridge.
- Mock end-to-end integration suite passed.
- One initial live Paperclip → Rool onboarding task completed successfully in seconds with the bridged worker correctly respecting the control-plane boundary.

This should still be treated as an early release. Independent testing and compatibility reports are specifically requested.

## Deliberate omissions

The adapter does not advertise features the current verified Rool runtime cannot implement reliably, including model enumeration, provider quota windows, authoritative Rool cost/token accounting, ACP, Paperclip device-login, automatic remote-host provisioning, adapter-driven context compaction and provider-side hire hooks.

## Security

Do not expose Rool credentials or Paperclip JWTs in public issues. The Paperclip JWT is intentionally retained on the bridge side and is not sent to the Rool worker.
