# Cascade CLI — Backlog

Tracked feature ideas and architectural explorations not yet scheduled.

---

## Pod Encryption Layer

**Status:** Exploration / not started
**Filed:** 2026-04-28
**Motivation:** The CLI is primarily a developer tool today, but the same pod format is intended to be usable by patients directly. A patient running the CLI on a personal machine — possibly shared, possibly compromised — should not have their health data sitting in plaintext `.ttl` files protected only by OS file permissions.

### Current State

- Pods are plaintext Turtle files on disk
- No authentication, no encryption at rest, no encryption in transit
- Security relies entirely on OS file permissions
- MCP server runs locally (stdio or localhost-only SSE)

### Threat Model (to refine)

Primary scenarios to protect against:
- Device theft (disk-at-rest exposure)
- Shared user account on a family/clinic machine
- Malware reading filesystem outside the CLI process
- Accidental cloud-sync of pod directory (Dropbox, iCloud Drive)

Out of scope (initially):
- Active in-memory attacks while pod is unlocked
- Compromised MCP-connected agents
- Multi-party / shared-pod scenarios

### Design Constraints

1. **RDF/Turtle is text** — encryption granularity choice (file vs. dir vs. whole pod) affects queryability
2. **Deterministic URIs (CDP-UUID, SHA-1)** leak content if visible outside encrypted boundary
3. **MCP tools** (`cascade_pod_read`, `cascade_pod_query`, etc.) must work transparently or gain auth
4. **Local-first** — no mandatory network/server component
5. **Reconciliation needs plaintext** for cross-record dedup

### Candidate Approaches

| # | Approach | Granularity | Complexity | Notes |
|---|----------|-------------|------------|-------|
| 1 | Encrypted pod container (AES-256-GCM, Argon2id KDF, unlock to tmpfs) | Whole pod | Low | Minimal code change; all-or-nothing access |
| 2 | Per-file envelope encryption (DEK per file, KEK wraps DEKs) | Per-file | Medium | Granular; filename metadata still leaks categories |
| 3 | OS keychain-backed KEK (macOS Keychain / Windows DPAPI / secret-service) + biometrics | Layer over 1 or 2 | Medium | Best UX; doesn't help on shared OS session |
| 4 | Solid-OIDC + DPoP + WAC ACLs | Per-resource | High | Standards-aligned; requires OIDC; overkill for local-only |
| 5 | Age encryption with identity keys | Per-file or whole pod | Low-medium | Simple multi-recipient sharing; identity file management critical |

### Recommended Phasing

1. **Phase 1:** Encrypted pod container (Approach 1) — covers untrusted-machine threat with minimal disruption
2. **Phase 2:** OS keychain integration (Approach 3) — passphrase-less UX
3. **Phase 3:** Per-file encryption (Approach 2) — enables granular sharing
4. **Phase 4:** Age-based multi-recipient (Approach 5) — patient-to-provider sharing

### Open Questions

- **Threat model precision:** Theft vs. shared account vs. malware — each shifts the design
- **Key recovery:** Lost passphrase = lost data? Privacy says yes, usability says no — hard tradeoff for health records
- **MCP agent scoping:** Should connected agents (e.g. Claude via MCP) get unrestricted decrypted-pod access, or per-tool scopes?
- **Export format:** Should `cascade pod export` produce encrypted archives? Which standard?
- **Cross-SDK consistency:** Encryption format must be reproducible by `sdk-typescript`, `sdk-python`, `cascade-sdk-swift`
- **Vocabulary impact:** Does the encrypted pod need new core vocabulary terms (e.g. `cascade:encryptedContainer`, key-wrap metadata)?

### Related Work

- `cascade-sdk-swift` already uses AES-256-GCM for sensitive data at rest — align encryption choice
- Solid pod structure already includes `.well-known/solid` and WebID stubs — leaves door open for Approach 4
- Audit log at `provenance/audit-log.ttl` provides non-repudiation, complementary to confidentiality

### Next Steps (when picked up)

1. Confirm threat model and target user persona with stakeholders
2. Prototype Phase 1 encrypted-container in a feature branch
3. Decide on KDF parameters (Argon2id memory/time cost) appropriate for patient-tier hardware
4. Spec the on-disk container format; align with SDK encryption format
5. Design unlock/lock UX (`cascade pod unlock`, auto-lock timeout, status indication)
