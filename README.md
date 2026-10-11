# Paperclip ↔ Rool Machine adapter

Unofficial community integration that lets [Paperclip](https://github.com/paperclipai/paperclip) run workers on Rool Machines through a Paperclip external adapter and a small Rool bridge.

> **Status: early community release.** v0.2.1 includes the first post-release compatibility fix and a mock end-to-end integration suite. The integration has completed real Paperclip → Rool onboarding runs, but it has not yet had broad production testing.

This project is not affiliated with or endorsed by Paperclip or Rool.

## What it supports

- Paperclip run JWT kept on the bridge side and never sent to the Rool worker
- Paperclip Secrets via `ROOL_CREDENTIALS_JSON`
- managed Instructions bundles
- Paperclip Skills transport
- task-scoped session continuity across heartbeats
- same-run retry protection
- force-fresh-session requests
- issue attachments, including binary files
- issue/project/goal/ancestor/comment/wake context
- structured JSONL run events and Paperclip UI parser
- real Test Environment checks against the configured Rool account and machine
- Paperclip checkout, manager-review request, result persistence and final state update
- explicit transport limits instead of silent truncation

See [docs/CAPABILITIES.md](docs/CAPABILITIES.md) for the complete capability matrix and deliberate omissions.

## Architecture

```text
Paperclip agent
    │
    ▼
rool_machine external adapter
    │  run-scoped Paperclip context + Secret materialization
    ▼
bridge/bridge.mjs
    │  Rool SDK
    ▼
Rool Machine / rool agent

Rool receives task/instruction/skill/file context.
Rool does not receive the Paperclip control-plane JWT.
The bridge owns Paperclip lifecycle mutations.
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Requirements

- a working Paperclip installation with external adapters enabled
- a Rool account and a machine exposing the `rool` agent
- `@rool-dev/sdk` and its Node auth support available to the bridge runtime
- a Paperclip Secret containing the complete Rool credential JSON, normally bound as `ROOL_CREDENTIALS_JSON`

## Install

Download the release asset `paperclip-rool-machine-v0.2.1.zip`, extract it somewhere visible inside the Paperclip container, then run:

```sh
./install.sh
```

The installer defaults to `PAPERCLIP_ROOT=/paperclip`. Override it when required:

```sh
PAPERCLIP_ROOT=/some/other/path ./install.sh
```

It supports both a fresh install and an upgrade. Existing adapter/bridge files are backed up before replacement. It does **not** restart Paperclip automatically.

After installation, restart Paperclip so it reloads the external adapter and UI parser.

## Agent configuration

Select adapter type `rool_machine` and configure:

- `machineId` — exact case-sensitive Rool machine ID
- `profile` — Rool account profile, usually `default`
- `label` — optional human-readable worker label
- bridge path/cwd/timeouts — defaults are normally sufficient
- `ROOL_CREDENTIALS_JSON` — bind from Paperclip Secrets rather than pasting credentials directly

Once installed, Paperclip should expose Instructions, Skills and Test Environment support for the Rool agent.

## Security model

The bridge is intentionally the trust boundary between Paperclip and the remote worker. The worker gets task data, selected instructions/skills and attachments, but not the Paperclip API key/JWT used for lifecycle mutations.

Read [SECURITY.md](SECURITY.md) before exposing the integration outside a trusted environment.

## Testing

No live credentials are required for the bundled test suite:

```sh
npm run verify
```

The suite mocks Paperclip and the Rool SDK and exercises Instructions, Skills, binary attachments, rich context, session resume, retry idempotency, force-fresh session behavior, checkout, review request, result persistence and UI parsing.

## Contributing

Issues and pull requests are welcome. In particular, independent testing against different Paperclip and Rool versions is useful at this stage.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
