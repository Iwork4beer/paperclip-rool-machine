# Paperclip adapter capability audit — Rool Machine

Audited 2026-10-05 against the current Paperclip external-adapter contract and the verified Rool SDK capabilities used by this deployment.

## Implemented

- `execute`
- `testEnvironment`
- `listSkills`
- `syncSkills`
- `sessionCodec`
- `supportsLocalAgentJwt: true`
- `supportsInstructionsBundle: true`
- `instructionsPathKey: "instructionsFilePath"`
- `requiresMaterializedRuntimeSkills: true`
- declarative `getConfigSchema`
- `agentConfigurationDoc`
- external adapter UI parser contract `1.0.0`
- structured adapter result metadata and error codes

Additional bridge-side capabilities needed to make those Paperclip features real rather than cosmetic:

- complete managed Instructions directory transport;
- selected materialized Skills directory transport;
- persistent Rool conversation reuse across Paperclip heartbeats;
- same-run idempotency;
- force-fresh conversation support;
- Paperclip issue attachment download and Rool upload;
- issue/heartbeat/comments/wake context collection;
- safe Test Environment Rool probe;
- atomic task checkout and result persistence;
- best-effort manager-review interaction.

## Not advertised because not truthfully implementable with the verified runtime

### `models`, `listModels`, `modelProfiles`, `listModelProfiles`, `refreshModels`, `detectModel`

The Paperclip-side Rool integration selects a Rool machine/agent, not a verified underlying model identifier. Exposing guessed model metadata would be false.

### `getQuotaWindows`

No verified Rool SDK quota/rate-limit API is available to this bridge.

### provider token/cost usage

The verified Rool conversation state does not expose a trustworthy Paperclip-compatible token/cost accounting record. The adapter therefore does not invent usage or cost.

### ACP

Rool is not being used as an Agent Client Protocol runtime in this deployment.

### login capability

Authentication is already supplied by Rool credentials held in Paperclip Secrets and consumed by `NodeAuth`. There is no verified Paperclip device-login flow to advertise.

### `getRuntimeCommandSpec`

The integration depends on the persistent local bridge, Rool SDK installation and Paperclip-side Secret binding. It cannot truthfully claim it can self-provision an arbitrary fresh SSH/sandbox execution target.

### `onHireApproved`

Hiring a Paperclip Rool-backed agent requires no provider-side lifecycle action.

### adapter session compaction management

Conversation persistence is supported. Explicit adapter-controlled Rool context compaction/reset is not exposed by the verified SDK. Paperclip `forceFreshSession` is supported by creating a fresh conversation instead.
