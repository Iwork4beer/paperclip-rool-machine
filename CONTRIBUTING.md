# Contributing

Contributions are welcome, particularly compatibility reports, reproducible bug reports and small patches that preserve the bridge security boundary.

## Before opening a pull request

1. Do not include real Rool credentials, Paperclip JWTs, machine IDs, company IDs, private hostnames or customer data.
2. Keep external-adapter capability flags honest: only advertise a feature when it is implemented end-to-end.
3. Keep the Paperclip control-plane credential bridge-side. Do not pass it to the Rool prompt or attachments.
4. Preserve retry idempotency and task-scoped session behavior.
5. Run:

```sh
npm run verify
```

## Bug reports

Include Paperclip version/tag, Rool SDK version, adapter version, whether the failure happens in Test Environment or a real run, and sanitized logs/events sufficient to reproduce the issue.

## Pull requests

Prefer focused changes. Add or update a regression test for behavior changes. Describe any compatibility assumptions in the PR body.
