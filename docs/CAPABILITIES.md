# Capability matrix

## Implemented

| Capability | Status |
|---|---|
| Paperclip run JWT isolation | Yes |
| Paperclip Secrets | Yes |
| Managed Instructions bundle | Yes |
| Paperclip Skills | Yes |
| Session continuity | Yes |
| Same-run retry protection | Yes |
| Force fresh session | Yes |
| Issue attachments | Yes |
| Rich task context | Yes |
| Structured run UI parser | Yes |
| Test Environment remote probe | Yes |
| Manager review request | Yes, best effort |
| Final result persistence | Yes |
| Transport limits | Yes |

## Deliberately not advertised

The current verified Rool runtime does not expose enough reliable information/control for the adapter to claim these features correctly:

- model enumeration/profiles/automatic model detection
- provider quota windows
- authoritative Rool token/cost accounting
- ACP mode
- Paperclip device-login workflow
- automatic remote execution-target provisioning
- adapter-controlled Rool context compaction
- provider-side hire lifecycle callbacks

Please do not add capability flags merely to make controls appear in Paperclip. A capability should only be advertised when the adapter can implement its contract end-to-end.
