# `rool_machine` Paperclip external adapter

This directory contains the Paperclip-facing half of the integration.

It declares supported adapter capabilities, validates configuration, handles Paperclip Secrets, synchronizes Instructions/Skills, maintains session parameters, launches the bridge and parses structured bridge events.

The remote worker is intentionally not given Paperclip control-plane credentials. See the repository root README and `docs/ARCHITECTURE.md`.
