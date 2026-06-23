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
| `cascade pod import` / `pod query` / `validate` | Encryption-aware: if the pod is encrypted, resolve the DEK and route every resource read/write through the decrypt/encrypt helpers. Plaintext pods are unchanged. |

### Passphrase handling

The passphrase is **never** taken as a command-line argument (that would leak it
into `ps` and shell history). It is resolved in this order:

1. The **`CASCADE_POD_PASSPHRASE`** environment variable (for CI / scripting).
2. A **hidden interactive prompt** on a TTY (input echo suppressed). `init` and
   `encrypt` additionally prompt for confirmation.

If a pod is encrypted and no passphrase is available (no env var,
non-interactive), encryption-aware commands fail with a clean error instructing
the caller to set `CASCADE_POD_PASSPHRASE` or run interactively.

## Known limitations (v1)

- `cascade pod conflicts` / `cascade pod resolve` read and write
  `settings/pending-conflicts.ttl` and `settings/user-resolutions.ttl` as
  plaintext. They are **not yet encryption-aware**. `cascade pod encrypt` will
  encrypt those files if they already exist (they are `settings/*.ttl`), after
  which the conflicts/resolve commands cannot read them until they are wired the
  same way as import/query/validate. A freshly initialized + imported pod only
  creates these files when reconciliation conflicts occur.
- Key rotation (change passphrase / add a wrap) is not yet exposed as a command,
  though the manifest format already supports it.
