# Security policy

## Sensitive material

Never post any of the following in a public issue:

- Rool credential JSON
- Paperclip API keys or run JWTs
- private hostnames/IPs if they identify a private network
- customer task data or attachments
- unredacted environment dumps

## Design boundary

The integration deliberately keeps Paperclip lifecycle credentials on the adapter/bridge side. A remote Rool worker should not receive them.

Rool credentials should be supplied through Paperclip Secrets and materialized only for the duration of the run. Temporary credential files should remain mode `0600` and be removed after use.

## Reporting a vulnerability

Until a private security contact is configured for the repository, do not publish credential-bearing proof-of-concept material. Open a minimal issue stating that you found a security problem and ask the repository owner for a private contact channel.
