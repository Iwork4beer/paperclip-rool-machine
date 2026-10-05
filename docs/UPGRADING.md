# Upgrading

`install.sh` supports a fresh install or replacement of an existing `rool-machine` external adapter/bridge deployment.

If an existing adapter or bridge is present, the installer first creates a timestamped backup under:

```text
/paperclip/backups/rool-machine-<timestamp>
```

Then it installs the release files and verifies them byte-for-byte against the extracted release package.

The installer does not restart Paperclip. Restart the Paperclip service/container after a successful install.

To restore a backup:

```sh
./rollback.sh /paperclip/backups/rool-machine-<timestamp>
```

and restart Paperclip again.
