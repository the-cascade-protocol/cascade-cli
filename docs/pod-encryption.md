# Encrypted pods in the CLI (encryption at rest)

> **The format is specified in the Cascade Protocol specification:
> [`pod-encryption.md`](https://github.com/the-cascade-protocol/spec/blob/main/pod-encryption.md)**
> (version 1.0, Draft). That document is normative for every implementation:
> the sealed file layout, which files stay plaintext, the header
> `settings/encryption.json` in versions 1.0 and 1.1, the reader limits, the
> writer invariants, the re-key, file system safety, and the security
> considerations. Section numbers below refer to it.
>
> This document covers how `cascade` implements that format and how to operate
> it: commands, passphrase handling, `--json` output, exit codes and `reason`
> strings, error messages, and where each rule lives in the source. Where this
> document and the specification disagree, the specification is authoritative
> and the difference is a bug in this tool.

A pod is encrypted **iff** anything is present at `settings/encryption.json`
(spec section 4.1). Plaintext pods (nothing at that path) are unaffected: all
read and write paths fall through to plaintext. In an encrypted pod every
regular file is sealed except the three plaintext-by-design paths of spec
section 3.2 (`settings/encryption.json`, `README.md`,
`provenance/egress-log.jsonl`); in this tool that list is
`PLAINTEXT_BY_DESIGN` in `src/lib/pod-resources.ts`.

## Envelope encryption

A random per-pod 256-bit data key (DEK) seals every file; the DEK is wrapped
by a key-encryption key (KEK) derived from a passphrase, and the wrapped DEK is
stored in the header (spec section 1.1). Changing the passphrase re-wraps the
same DEK without touching any sealed file; replacing the DEK is a re-key (see
[Re-keying](#re-keying-a-new-data-key)).

## Sealed files

The layout is `nonce(12) || ciphertext || tag(16)` under AES-256-GCM with no
associated data (spec sections 2 and 3.1), byte-for-byte Apple CryptoKit's
`AES.GCM.SealedBox.combined`. The CLI builds and parses it over Node's
`node:crypto`:

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

A GCM authentication failure on a sealed file (wrong key or tampered bytes)
surfaces as one error: **`incorrect passphrase or corrupt key`**.

## Key derivation

The KEK is Argon2id (spec section 2) from `@noble/hashes`, a pure-JS
implementation, so there is no native build step. New passphrase wraps use the
specification's defaults, `t = 3`, `m = 65536` (KiB, 64 MiB), `p = 1`, with a
fresh 16-byte random salt and a 32-byte output.

## The header, `settings/encryption.json`

The header's members, both versions, the wrap kinds, the wrap identifier and
the 1.0 to 1.1 migration are specified in spec sections 4 and 6.4.

What this tool reads and writes:

- **Reads** versions `1.0` and `1.1`. Any other version is refused with a
  message that the pod was written by a newer tool
  (`reason: "manifest-version-unsupported"`).
- **Writes** version `1.1` from every command that writes the header.
  `pod init --encrypt` and `pod encrypt` write one passphrase wrap with
  `label: "primary"` and `createdAt` set when the pod key is created;
  `pod passphrase set` migrates a 1.0 header in memory and re-wraps;
  `pod passphrase set --rotate-dek` writes one wrap of a new data key.
- **Wrap kinds.** `passphrase` is implemented. `device-keychain` is reserved by
  the specification and not implemented; like any kind this tool does not
  implement, it is skipped. A header with no wrap this tool implements cannot
  be opened here:

  ```
  Cannot open this pod: its encryption manifest holds no wrap this tool implements
  ```

`src/lib/pod-encryption.ts` is the only code that reads the header's key
material. It reads both versions into one normalized shape (a list of wraps,
each passphrase wrap with its own KDF parameters), and a source test fails if
`kdfParams` or `wrappedDek` is read anywhere else.

### Reader limits

The limits, the lexical rules for `t`, `m`, `p`, `salt` and `wrappedDek`, and
the rule that the whole header is validated before any key is derived are
spec sections 4.5, 5.2 and 5.3. A header outside them is refused as malformed
(`reason: "manifest-malformed"`); the message names the field and never echoes
the value:

```
The pod's encryption header asks for settings outside this tool's limits (field: wraps[0].kdfParams.m).
```

Every writer in this tool stays inside the limits, and a test pins that;
`buildPassphraseManifest` refuses parameters outside them rather than write a
header a reader would refuse. Measured cost of the worst case the limits allow
(six passphrase wraps at `m=131072, t=6, p=4`) with this tool's pure-JS
Argon2id on an Apple M5: about 1.7 seconds per wrap, 10.2 seconds for all six,
at about 305 MiB of resident memory.

### The header file itself

How the header is opened (never through a symbolic link, without blocking,
kind checked on the open handle, read bounded to 65537 bytes, strict UTF-8
with no byte order mark) is spec section 5.1. Each refusal is an ordinary
malformed-header refusal (`reason: "manifest-malformed"`):

```
Malformed settings/encryption.json: not a regular file
```

A `settings` directory that is a symbolic link makes the pod encrypted, whether
or not a header is behind it, and is then refused: such a pod reads as locked,
never as a plaintext pod a writer would store plaintext into (spec section 4.1).

### Symbolic links inside a pod

The rule is spec section 8. In this tool every read and write of a file or
folder inside a pod resolves its path through one chokepoint,
`src/lib/pod-path.ts`, which checks each existing component with `lstat`,
refuses `..` and paths outside the pod, confirms the resolved path is under the
pod root, opens files without following a link or blocking, and creates
folders one component at a time. The pod root itself, and any folder above it,
may be a symbolic link.

A refused read is a file the command could not read (exit 2); a refused write
names the file and fails the command, and nothing is written outside the pod.
The error names the pod-relative path and never where a link points.
`pod export` refuses a pod holding a link or special file
(`reason: "symlink-in-pod"`, exit 2), since the export would either leave the
file out or copy another folder's contents into it; the encrypt, decrypt and
record walks skip links, and a re-key refuses them.

## Commands

| Command | Behavior |
|---------|----------|
| `cascade pod init <dir> --encrypt` | Generate a DEK, derive the KEK from the passphrase, write the manifest, then write all template resources **encrypted**. |
| `cascade pod encrypt <dir>` | Migrate an existing **plaintext** pod to encrypted in place. Guards if already encrypted. |
| `cascade pod decrypt <dir>` | Reverse: decrypt every resource back to plaintext and remove the manifest. |
| `cascade pod passphrase set <dir>` | Change the passphrase by re-wrapping the DEK. See [Changing the passphrase](#changing-the-passphrase). |
| `cascade pod passphrase set <dir> --rotate-dek` | Change the passphrase AND the DEK: every sealed file is re-encrypted under a new key. See [Re-keying](#re-keying-a-new-data-key). |
| `cascade pod import` / `pod query` / `validate` | Encryption-aware: if the pod is encrypted, resolve the DEK and route every resource read/write through the decrypt/encrypt helpers. Plaintext pods are unchanged. |

Every write of `settings/encryption.json` is atomic and durable, including the
manifest `pod init --encrypt` and `pod encrypt` write: a new temporary file
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

**How long secrets live in memory.** A passphrase is a JavaScript string and
cannot be zeroed; it lives until the process exits or it is collected. Its
encoded bytes are zeroed as soon as the KEK is derived. Every KEK is zeroed
after its one use, the decrypt step leaves no second copy of an unwrapped key,
and `pod init --encrypt`, `pod encrypt` and `pod decrypt` zero the pod key when
they finish. Commands that read or import hold the key for the whole command.
A model server that `pod extract` starts does not inherit the passphrase
variables. Neither the passphrase nor any key is ever printed or logged.

### Changing the passphrase

`cascade pod passphrase set <dir>` re-wraps the pod's DEK under a new
passphrase (spec section 6.5). Every resource is sealed under the DEK, not the
passphrase, so the change is one write of `settings/encryption.json`; no
resource file is read or written, and the DEK never touches disk.

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

### Re-keying (a new data key)

A re-wrap changes which passphrase opens the DEK and nothing else, so anyone
who opened the pod before could have kept the DEK itself and still read every
file. `cascade pod passphrase set <dir> --rotate-dek` cuts that off: it
generates a NEW DEK, re-encrypts every sealed file under it (spec section 7),
and writes a 1.1 header with exactly ONE passphrase wrap, for the new
passphrase (its `label` kept from the wrap the current passphrase opened, else
`"primary"`; fresh salt; `createdAt` now). Other wraps are not carried over: their holders' secrets are
not available, and dropping them is the revocation.

Both passphrases come from the environment only, `CASCADE_POD_PASSPHRASE` (the
current one) and `CASCADE_POD_NEW_PASSPHRASE`. There is no prompt: either one
missing or empty is exit 1 with `reason: "passphrase-missing"`, and nothing is
touched.

The pod is never rewritten in place:

1. The current passphrase must open the header (refusals: exit 2 with
   `passphrase-incorrect`, `manifest-malformed` or
   `manifest-version-unsupported`; nothing touched). A symbolic link or any
   entry that is not a regular file or a directory, anywhere in the pod, is
   refused (exit 1) before anything is written. A file that cannot be read is
   exit 2, `files-unreadable`, with `files` naming it.
2. A complete re-encrypted copy is built in a sibling folder,
   `.<name>.rekey-<12 hex>` in the pod's parent directory (so the final renames
   stay on one volume). Every file that opens with the current DEK is sealed
   under the new one; every other file (plaintext by design, or bytes that are
   not sealed under this pod's key) is copied byte for byte, so its state does
   not change; a temporary header left by a killed write is not carried over.
   Every file goes through the same atomic, fsynced write as every other pod
   write, the header is written last, and every folder is fsynced.
3. The copy is verified before anything moves: the new passphrase opens its
   header to the new DEK; it holds exactly the expected files and folders;
   every re-sealed file decrypts to the same plaintext hash as the original,
   and every copied file has the same hash. Then the pod is re-scanned, and if
   anything in it changed while the copy was built the re-key stops. Any
   failure deletes the copy and exits non-zero with the pod untouched.
4. The pod is renamed to `.<name>.old-<same hex>`, the copy is renamed to
   `<name>`, and the parent directory is fsynced. The second rename is the
   commit point. Then the `.old` folder is deleted. If the second rename fails,
   the first is undone. If deleting `.old` fails after the commit point, the
   re-key is still reported as done (the new passphrase is the only one that
   opens the pod) and a warning names the old copy, which still opens with the
   old passphrase; `pod doctor --write` deletes it.

Output with `--json` (exit 0), and nothing else on stdout:

```json
{ "podDir": "/path/to/pod", "manifestVersion": "1.1", "wrapCount": 1, "createdAt": "2026-09-24T17:04:11.123Z", "dataKeyRotated": true, "resources": 42 }
```

`resources` is the number of files re-encrypted. On any non-zero exit the
folder at `<dir>` opens with the current passphrase exactly as before, and no
staging or `.old` folder is left behind, except when the process is killed
part way (below).

**If the process is killed part way.** The folders left beside the pod say how
far it got, matched by the shared hex. The next run of the command (before it
opens the pod), or `cascade pod doctor <dir> --write`, finishes or undoes it and
prints a warning saying which; `pod doctor` without `--write` reports it and
changes nothing. None of this needs a passphrase.

| Killed | Folders left | What the next run does | Which passphrase opens the pod |
|---|---|---|---|
| while building or verifying the copy | the pod, and `.<name>.rekey-<hex>` | deletes the copy | the **current** one |
| between the two renames | `.<name>.old-<hex>` and `.<name>.rekey-<hex>`, no pod | renames `.old` back to the pod, then deletes the copy | the **current** one |
| after the second rename | the pod, and `.<name>.old-<hex>` | deletes `.old` | the **new** one |

At every point exactly one of the two passphrases opens the pod, and nothing is
lost. A process killed after the commit point but before it printed its result
has still changed the key; a caller that did not see the result should try the
new passphrase when the current one is refused. Any other combination of these
folders (for example a copy with no pod and no `.old`) is never guessed at: the
command and `pod doctor` refuse with exit 1 and name the folders.

Run it when nothing else is writing to the pod: a write that lands after the
copy is made is detected and stops the re-key, except in the instant between
the final re-scan and the first rename.

A copy of the pod made before the change still opens with the old passphrase:
the copy carries its own header and its own copy of the old DEK.

## Known limitations

- **Sealed files are not bound to their paths** (spec section 9.4). The format
  uses no associated data, so anyone who can write to the pod folder can copy
  one sealed file over another, or restore an older sealed copy of a file, and
  this tool accepts the result as authentic, as every conforming reader does.
  Do not treat an encrypted pod as tamper-evident against someone who can write
  to its folder. The ratified design that binds each file to its path is
  [D-SEAL-1](https://github.com/the-cascade-protocol/spec/blob/main/decisions/2026-09-26-sealed-resource-binding.md);
  it is not yet part of the format.
- Changing the passphrase is `pod passphrase set`, and re-keying is
  `pod passphrase set --rotate-dek`. Adding a second wrap is not yet exposed as
  a command.

## Conformance

The cross-implementation fixtures and vectors for the format live in the
[`conformance`](https://github.com/the-cascade-protocol/conformance) repository
under `pod-encryption/` (spec section 10). Its harness drives this tool
through the command line and ratchets the result against
`pod-encryption/KNOWN_FAILURES.json`. From a `conformance` checkout, with this
tool built:

```bash
python3 scripts/check_pod_encryption.py --cascade "node /path/to/cascade-cli/dist/index.js"
```
