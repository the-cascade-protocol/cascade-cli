# Encrypted resources (encryption at rest)

> **Status:** Implemented in `@the-cascade-protocol/cli`. This document is the
> working spec for the on-disk encryption format. **Promote this into
> `spec/pod-structure.md`** (the authoritative pod-structure spec) once the
> format is ratified, so the Swift SDK, TypeScript/Python SDKs, and the CLI all
> reference one source of truth.

A Cascade Pod may be encrypted at rest. When enabled, every pod **resource**
(the `.ttl` files plus the non-`.ttl` resources `.well-known/solid` and
`settings/preferences`) is stored as ciphertext on disk, while the CLI
transparently decrypts on read and encrypts on write. `README.md` is left as
plaintext documentation and is not a pod resource.

A pod is encrypted **iff** it contains an encryption manifest at
`settings/encryption.json`. Plaintext pods (no manifest) are unaffected: all
read/write paths fall through to plaintext.

## Envelope encryption

Encryption uses an envelope (two-key) scheme:

- A random per-pod **Data Encryption Key (DEK)** — 256-bit — encrypts each
  resource.
- The DEK is **wrapped** (encrypted) by a **Key Encryption Key (KEK)** derived
  from a passphrase. The wrapped DEK is stored in the manifest.

This lets the passphrase be changed (re-wrap the same DEK) without re-encrypting
every resource, and lets multiple key holders unlock the same pod by storing
multiple wraps of the same DEK (see [Multi-wrap design](#multi-wrap-design)).

## Resource layout (`.combined`, CryptoKit-interoperable)

Each encrypted resource blob is exactly:

```
nonce(12) || ciphertext || tag(16)
```

- **Cipher:** AES-256-GCM (256-bit DEK).
- **nonce:** 12 random bytes, fresh per write.
- **tag:** 16-byte GCM authentication tag.
- **No magic header** precedes the blob.

This is byte-for-byte identical to Apple CryptoKit's
`AES.GCM.SealedBox(...).combined` representation, so blobs written by this CLI
are directly openable by the Swift SDK's `PodEncryption` (and vice versa).

The CLI builds/parses the combined layout manually over Node's `node:crypto`:

```ts
// encrypt
const nonce = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', dek /* 32 bytes */, nonce);
const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const tag = cipher.getAuthTag();          // 16 bytes
const blob = Buffer.concat([nonce, ct, tag]);

// decrypt
const nonce = blob.subarray(0, 12);
const tag = blob.subarray(blob.length - 16);
const ct = blob.subarray(12, blob.length - 16);
const decipher = createDecipheriv('aes-256-gcm', dek, nonce);
decipher.setAuthTag(tag);
const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
```

Any GCM authentication failure (wrong key or tampered bytes) surfaces as a
single clean error: **`incorrect passphrase or corrupt key`**.

## Key derivation (Argon2id)

The passphrase KEK is derived with **Argon2id** (memory-hard, side-channel
resistant) via `@noble/hashes` — a pure-JS implementation, so there is no native
build step. Default parameters (recorded in the manifest):

| Param | Value | Meaning |
|-------|-------|---------|
| `t`   | 3     | time cost (iterations) |
| `m`   | 65536 | memory cost in **KiB** (= 64 MiB) |
| `p`   | 1     | parallelism |
| —     | salt  | 16 random bytes (base64 in manifest) |
| —     | dkLen | 32 bytes (256-bit KEK) |

The parameters are stored in the manifest so a future reader can reproduce the
KEK even if the defaults change.

## Manifest schema — `settings/encryption.json`

```jsonc
{
  "version": "1.0",
  "algorithm": "aes-256-gcm",
  "kdf": "argon2id",
  "kdfParams": {
    "salt": "<base64>",   // Argon2id salt
    "t": 3,               // time cost
    "m": 65536,           // memory cost (KiB)
    "p": 1                // parallelism
  },
  // Multiple wraps of the SAME DEK may coexist.
  // v1 implements only the "passphrase" wrap.
  "wraps": [
    {
      "by": "passphrase",
      "wrappedDek": "<base64 combined nonce||ct||tag>"
    }
  ]
}
```

The `wrappedDek` is itself a combined AES-256-GCM blob (the DEK encrypted under
the KEK), base64-encoded.

The schema above is **version 1.0**. `pod init --encrypt` and `pod encrypt`
write it.

### Version 1.1

`pod passphrase set` writes **version 1.1**, which moves the KDF parameters
into each passphrase wrap (one salt cannot serve two secrets) and gives each
wrap a `label` and a `createdAt`:

```json
{
  "version": "1.1",
  "algorithm": "aes-256-gcm",
  "wraps": [
    {
      "by": "passphrase",
      "label": "primary",
      "createdAt": "2026-09-23T17:04:11.123Z",
      "kdf": "argon2id",
      "kdfParams": { "salt": "<base64 of 16 random bytes>", "t": 3, "m": 65536, "p": 1 },
      "wrappedDek": "<base64 of nonce(12) || ciphertext(32) || tag(16)>"
    }
  ]
}
```

Rules:

1. No top-level `kdf` or `kdfParams` in 1.1. A 1.1 manifest that carries
   either is malformed: readers refuse it, writers never produce it.
2. Every `passphrase` wrap carries its own `kdf` (`"argon2id"`) and
   `kdfParams`. Salts are 16 random bytes, fresh per wrap, and unique across
   the wraps of one manifest.
3. `label` is a string or `null`. Neutral words only (`"primary"`): the
   manifest is plaintext and travels with the folder.
4. `createdAt` is an ISO 8601 UTC timestamp with milliseconds, or `null` for a
   wrap migrated from 1.0 whose age is unknown. It is set once when the wrap is
   created.
5. `wraps` is never empty.
6. `by` is `"passphrase"` or `"device-keychain"` (reserved, not implemented).
   Readers skip a wrap whose non-empty `by` they do not implement; a missing,
   non-string or empty (`""`) `by` makes the whole manifest malformed. A
   manifest with no wrap the reader implements cannot be opened.
7. A wrap's public identifier is its `kdfParams.salt`. In 1.0 the single
   top-level salt plays this role, so reading a 1.0 pod leaves its identifier
   unchanged, and a re-wrapped pod has a new one.
8. Readers accept `"1.0"` and `"1.1"`. Any other version is refused with a
   message that the pod was written by a newer tool.
9. To open: try each `passphrase` wrap in manifest order with its own KDF
   parameters; the first whose GCM tag verifies yields the DEK. All wraps
   resolve the same DEK.
10. Migration 1.0 to 1.1 (done in memory by the writing command): the top-level
    `kdf` and `kdfParams` move into the single `passphrase` wrap, its `label`
    becomes `"primary"` and its `createdAt` becomes `null`; any other wrap is
    carried over with `label: null` and `createdAt: null`. Reading a 1.0
    manifest without migrating it gives the same labels: the first
    `passphrase` wrap reads as `"primary"`, every other wrap as `null`.

In the CLI, `src/lib/pod-encryption.ts` is the only code that reads the
manifest's key material. It reads both versions into one normalized shape (a
list of wraps, each passphrase wrap with its own KDF parameters), and a source
test fails if `kdfParams` or `wrappedDek` is read anywhere else.

### Reader limits

The manifest is plaintext, so anyone who can write to the pod directory can
edit its KDF parameters, and a reader derives a key from whatever it finds
there. Without a bound, one edited number makes every open allocate gigabytes
or run for hours before the passphrase is even checked. Readers therefore
enforce these limits when the manifest is **parsed** (1.0 and 1.1 alike),
before any key derivation runs:

| Field | Accepted | Why |
|---|---|---|
| header file size | at most 65536 bytes; never more than 65537 bytes are read | a real header is under 1 KiB |
| `kdfParams.m` (KiB) | `8 * p` to 131072 (128 MiB) | writers use 65536 (64 MiB); 2x headroom |
| `kdfParams.t` | 1 to 6 | writers use 3 |
| `kdfParams.p` | 1 to 4 | writers use 1 |
| `kdfParams.salt` | canonical padded base64 of exactly 16 bytes | every writer uses 16 |
| `wrappedDek` | canonical padded base64 of exactly 60 bytes (12 nonce + 32 key + 16 tag) | a 256-bit data key |
| passphrase wraps per manifest | at most 6 | bounds try-each-wrap |
| wraps of any kind per manifest | at most 16 | bounds the parse |
| `kdf` | exactly `"argon2id"` | the only KDF implemented |

A value outside these limits anywhere in the manifest refuses the whole
manifest, even when an earlier wrap would have opened. The refusal names the
field and never echoes the value:

```
The pod's encryption header asks for settings outside this tool's limits (field: wraps[0].kdfParams.m).
```

Every writer stays inside the limits (`t=3, m=65536, p=1`, 16-byte salts,
60-byte wraps), and a test pins that; `buildPassphraseManifest` refuses
parameters outside them rather than write a manifest a reader would refuse. The
worst case the limits allow is six passphrase wraps at `m=131072, t=6, p=4`:
about 1.7 seconds per wrap and 10.2 seconds for all six with the pure-JS
Argon2id on an Apple M5, at about 305 MiB of resident memory. That is bounded,
which is the point.

### The header file itself

`settings/encryption.json` must be a **regular file**, reached without a
symbolic link. The reader opens it without following a link in its last
component and without blocking (so a FIFO cannot hang the open), then checks
the kind with `fstat` on the open handle, and refuses anything else: a
symbolic link (dangling or not), a FIFO, a device such as `/dev/zero`, a
directory, a socket. A `settings` directory that is itself a symbolic link is
refused the same way. The read is bounded to 65537 bytes whatever the handle
reports, because a device or a FIFO reports size 0.

These are ordinary malformed-header refusals (`reason: "manifest-malformed"`):

```
Malformed settings/encryption.json: not a regular file
```

Anything at the header path counts as the pod being encrypted, a dangling
link included, so a link there is refused rather than read as "not encrypted".

### Multi-wrap design

`wraps` is an **array** so the same DEK can be unlocked by different key holders.
Each entry is identified by its `by` discriminator:

- **`passphrase`** — implemented. DEK wrapped under an Argon2id passphrase KEK.
- **`device-keychain`** — **RESERVED, not implemented in v1.** The slot is
  documented so a future writer can add a wrap of the form
  `{ "by": "device-keychain", ... }` (DEK wrapped under a device keychain /
  secure-enclave key) **without a schema bump**. Readers should ignore wrap
  kinds they do not understand and fall back to one they can use.

## Commands

| Command | Behavior |
|---------|----------|
| `cascade pod init <dir> --encrypt` | Generate a DEK, derive the KEK from the passphrase, write the manifest, then write all template resources **encrypted**. |
| `cascade pod encrypt <dir>` | Migrate an existing **plaintext** pod to encrypted in place. Guards if already encrypted. |
| `cascade pod decrypt <dir>` | Reverse: decrypt every resource back to plaintext and remove the manifest. |
| `cascade pod passphrase set <dir>` | Change the passphrase by re-wrapping the DEK. See [Changing the passphrase](#changing-the-passphrase). |
| `cascade pod import` / `pod query` / `validate` | Encryption-aware: if the pod is encrypted, resolve the DEK and route every resource read/write through the decrypt/encrypt helpers. Plaintext pods are unchanged. |

Every write of `settings/encryption.json` is atomic and durable, including the
1.0 manifest `pod init --encrypt` and `pod encrypt` write: a new temporary file
(created, never reused) in `settings/`, fsync, rename over the manifest, fsync
of the directory. A crash mid-write leaves either the old state or the whole new
manifest, never a truncated one.

### Passphrase handling

The passphrase is **never** taken as a command-line argument (that would leak it
into `ps` and shell history). It is resolved in this order:

1. The **`CASCADE_POD_PASSPHRASE`** environment variable (for CI / scripting).
2. A **hidden interactive prompt** on a TTY (input echo suppressed). `init` and
   `encrypt` additionally prompt for confirmation.

If a pod is encrypted and no passphrase is available (no env var,
non-interactive), encryption-aware commands fail with a clean error instructing
the caller to set `CASCADE_POD_PASSPHRASE` or run interactively.

`pod passphrase set` takes the current passphrase the same way, and the new one
from **`CASCADE_POD_NEW_PASSPHRASE`**, else a hidden prompt entered twice that
must match.

### Changing the passphrase

`cascade pod passphrase set <dir>` re-wraps the pod's DEK under a new
passphrase. Every resource is sealed under the DEK, not the passphrase, so the
change is one write of `settings/encryption.json`; no resource file is read or
written, and the DEK never touches disk.

1. The current passphrase must open a wrap. If it does not, the command refuses
   before asking for the new one.
2. The manifest is migrated to 1.1 in memory if needed. The wrap that opened is
   replaced by a new passphrase wrap (fresh 16-byte salt, default KDF
   parameters, `createdAt` now, `label` kept or `"primary"`). Every other wrap
   is kept as it is.
3. The new manifest is written to a temporary file in `settings/` and fsynced,
   those bytes are read back and opened with the new passphrase to the same
   DEK, and only then is the file renamed over `settings/encryption.json` and
   the directory fsynced. Any failure before the rename removes the temporary
   file and leaves the manifest byte-identical. No backup of the old manifest
   is kept inside the pod, since it would keep the old passphrase working.
   A temporary manifest left in `settings/` by an earlier run that was killed
   is removed before the new one is written.

Refusals leave the manifest byte-identical: the pod is not encrypted (exit 1);
the new passphrase is empty or the same as the current one (exit 1); the
current passphrase opens no wrap, or the manifest is malformed or from a newer
tool (exit 2).

A copy of the pod made before the change still opens with the old passphrase:
the copy carries its own manifest. Output is one line of text, or with `--json`:

```json
{ "podDir": "/path/to/pod", "manifestVersion": "1.1", "wrapCount": 1, "createdAt": "2026-09-23T17:04:11.123Z" }
```

No passphrase, salt or key is ever printed.

## Known limitations (v1)

- `cascade pod conflicts` / `cascade pod resolve` read and write
  `settings/pending-conflicts.ttl` and `settings/user-resolutions.ttl` as
  plaintext. They are **not yet encryption-aware**. `cascade pod encrypt` will
  encrypt those files if they already exist (they are `settings/*.ttl`), after
  which the conflicts/resolve commands cannot read them until they are wired the
  same way as import/query/validate. A freshly initialized + imported pod only
  creates these files when reconciliation conflicts occur.
- Changing the passphrase is `pod passphrase set`. Adding a second wrap, and
  re-keying (a new DEK, which re-encrypts every resource), are not yet exposed
  as commands.
