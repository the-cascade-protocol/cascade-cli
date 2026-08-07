# Exit codes and the `--json` error envelope

This is the contract `cascade` promises to anything that shells it: a script, a
CI job, an MCP client, or a desktop app across an IPC boundary. It is pinned by
`tests/pod-read-conformance.test.ts`, which runs every read verb through the
same failure matrix, so a change here fails a test rather than a user.

## The three exit codes

| Code | Meaning | Examples |
|---|---|---|
| `0` | Success. The command did what was asked, and everything it needed to read, it read. | a query that answered; an export that was written |
| `1` | User or input error, including a choice the caller has to make. | pod directory not found; no query filter given; `--hops` out of range; a genuine "record not found"; an encrypted pod exported without `--allow-encrypted` |
| `2` | **Could not read what exists.** The pod, or a file inside it, could not be opened, decrypted, or parsed. | no passphrase for a sealed pod; the wrong passphrase; a registered record file that is not valid Turtle; a missing `settings/encryption.json` |

### Why 2 exists, and why it is the important one

An encrypted pod read without its key produces bytes that parse to nothing.
Every verb that treated that as "nothing to report" told the same lie: it
described a pod full of records as an empty one, at exit 0, with no warning.
That defect shipped four separate times (`pod decrypt`, `pod conflicts`,
`pod query`, `pod info`) before it was treated as structural.

So exit 2 is the code for **"unknown", which is not "zero"**. A caller must be
able to tell three states apart, and only the exit code does that reliably:

- there are no records (exit 0, empty result),
- the caller asked wrongly (exit 1),
- nobody knows what is in there (exit 2).

A command that exits 0 with an empty result is making a positive claim about
someone's health record. It must only ever do that when it is true.

### The rule read failures are weighed by

Two failures, weighed differently, because "fail on anything" is its own outage:

- A file that will not **decrypt** is always fatal. The pod's key is wrong for
  it, so nothing about its contents is known, including how much there is.
- A file that decrypts (or is plaintext) and is not valid **Turtle** is fatal
  only for a *registered record file* (the `clinical/…` and `wellness/…` files
  in the data-type registry), which is the record picture itself. For any other
  `.ttl`, it is a loud warning on stderr and the command still answers: a pod
  legitimately holds app-written resources under `notes/`, `analysis/`,
  `literature/` and `profile/`, and one stray file must not blank a pod's whole
  record list.
- A file the walker listed and then could not **read** at all is fatal, for the
  same reason as a decrypt failure: its contents are unknown.

Warnings go to stderr and never change the exit code. An error message for a
read failure always names the files it could not read.

### `pod doctor` reads the same three codes as a diagnosis

`cascade pod doctor` scans a pod for damage, so "there is something wrong" is its
normal successful answer rather than a failure. It maps onto the same three
codes without bending them:

| Code | For `pod doctor` |
|---|---|
| `0` | Nothing is wrong, or (under `--write`) everything found was repaired. |
| `1` | Damage remains: a dry run that found something, or a file doctor read and will not repair. Also "there is no pod at that path". |
| `2` | Something could not be **read**: the pod would not open, a resource did not decrypt, or a `.ttl` holds bytes that are not text. |

`2` outranks `1` when both apply. A file doctor could not open was never
examined, and a verb whose entire job is to report the state of your pod must
not describe files it never read. Its `--json` report carries a per-file
`status` of `repaired`, `repairable`, `refused` or `unreadable`, and the
unreadable ones are also named on stderr in the usual envelope.

## The `--json` error envelope

With `--json`, an error is a single JSON object on **stderr**. `error` is always
present and always a complete sentence; the other fields are additive, so a
consumer can branch on state instead of pattern-matching English.

```json
{
  "error": "Could not open the pod at /path/to/pod: this pod is encrypted and the passphrase was not provided (...). This is NOT the same as the pod having no records.",
  "pod": "/path/to/pod",
  "encrypted": true,
  "readable": false,
  "reason": "passphrase-missing"
}
```

| Field | Type | Meaning |
|---|---|---|
| `error` | string | Always present. The same sentence text mode prints. |
| `pod` | string | The pod the command was pointed at, when it had one. |
| `encrypted` | boolean | Whether the pod carries an encryption manifest. |
| `readable` | boolean | Whether the command could read what it needed. `false` is the machine-readable form of exit 2. |
| `reason` | string | Which unreadable state this is: `passphrase-missing`, `passphrase-incorrect`, or `files-unreadable`. |
| `files` | string[] | With `files-unreadable`: the pod-relative paths, forward slashes. |

`pod info` also states the *positive* case in its success payload
(`"encrypted": true, "readable": true`), so a consumer never has to infer
readability from the absence of an error.

### Unsealed files are not a wrong passphrase

A plaintext file inside a sealed pod fails authentication exactly as a wrong key
does. The two are told apart and reported differently, because sending someone
to re-check a passphrase that was correct is its own kind of false report. Such
a file is still treated as unreadable: bytes that did not authenticate under the
pod's key have not been shown to belong to the pod, and serving them as records
would spend the guarantee the encryption is there to provide.

## MCP tools

The same semantics, in MCP's shape. An unreadable pod is a typed error, never a
successful result whose counts happen to be zero: these tools feed agents that
restate what they are handed, so `totalRecords: 0` over a sealed pod is not a
soft failure but a confident false statement about someone's health record.

```json
{ "error": "...", "code": "pod-unreadable", "reason": "passphrase-missing", "encrypted": true, "readable": false }
{ "error": "...", "code": "pod-files-unreadable", "readable": false, "files": ["clinical/medications.ttl"] }
```

No audit entry is written for a read that failed, because no read happened.

## `--version`

`cascade --version` prints a bare SemVer string and nothing else (`0.10.0`), on
stdout, exit 0. Consumers may parse it to enforce a minimum version; Cascade
Workbench does exactly that at startup. Keep it parseable.

## Passphrases

An encrypted pod takes its passphrase from `CASCADE_POD_PASSPHRASE`, or a hidden
TTY prompt when running interactively. It is never accepted as a command-line
argument, which would leak it into the process table and shell history. A
non-interactive run with no environment variable is `passphrase-missing`, exit
2, not a prompt that hangs a script forever.
