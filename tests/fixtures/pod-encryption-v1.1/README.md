# Encrypted pod fixture, manifest version 1.1

A tiny synthetic encrypted pod whose `settings/encryption.json` was written by
`cascade pod passphrase set`, so readers of manifest version 1.1 can be tested
against the bytes this CLI actually writes.

**The passphrases below are TEST-ONLY values. They protect nothing but this
synthetic fixture. Never use them for a real pod.**

| | Passphrase |
|---|---|
| Opens this pod (current) | `birch meadow anchor violet copper lantern` |
| Opened it before the re-wrap (no longer works) | `copper velvet orbit lantern mossy quartz` |

## Contents

- `pod/`: the encrypted pod. `settings/encryption.json` is version 1.1 with one
  `passphrase` wrap (`label: "primary"`). Every resource is sealed under the
  pod's data key except the files left plaintext by design (`README.md` and the
  manifest).
- `synthetic-bundle.json`: the input that was imported. One MedicationStatement
  with a `urn:uuid:` identifier and no patient. No real person's data.

## How it was produced

With the CLI built from this repository (`npm run build`), in a scratch
directory `/tmp/pod-encryption-v1.1` (the absolute path is recorded in the
pod's `.well-known/solid` as `podUri`):

```sh
export CASCADE_POD_PASSPHRASE='copper velvet orbit lantern mossy quartz'
node dist/index.js pod init pod --encrypt
node dist/index.js pod import pod synthetic-bundle.json

export CASCADE_POD_NEW_PASSPHRASE='birch meadow anchor violet copper lantern'
node dist/index.js pod passphrase set pod
```

`pod init --encrypt` writes manifest version 1.0; `pod passphrase set` migrates
it to 1.1 and re-wraps the same data key under the new passphrase. No resource
file changed in that last step.

`tests/pod-encryption-fixture-v11.test.ts` checks that the fixture still opens
with the current passphrase, does not open with the old one, and decrypts to
the imported record.
