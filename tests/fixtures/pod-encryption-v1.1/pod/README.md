# Cascade Protocol Pod

This directory is a **Cascade Protocol Pod** -- a portable, self-describing collection of personal health data serialized as RDF/Turtle files.

## Structure

```
.well-known/
  solid                    # Pod discovery document (JSON)
profile/
  card.ttl                 # WebID profile (public — identity + discovery links only)
  extended.ttl             # Extended profile (private — PHI: DOB, address, phone, email)
settings/
  preferences              # Private preferences (owner-only — links to privateTypeIndex)
  publicTypeIndex.ttl      # Maps clinical data types to file locations
  privateTypeIndex.ttl     # Maps wellness data types to file locations
clinical/                  # Clinical records (EHR-sourced data)
wellness/                  # Wellness records (device and self-reported data)
index.ttl                  # Root LDP container listing all resources
```

## Getting Started

1. Edit `profile/card.ttl` to set the Pod owner's display name (public-safe).
2. Edit `profile/extended.ttl` to fill in PHI (DOB, address, phone, email) — keep this private.
3. Add clinical data files (e.g., `clinical/medications.ttl`) and register them in `settings/publicTypeIndex.ttl`.
4. Add wellness data files (e.g., `wellness/heart-rate.ttl`) and register them in `settings/privateTypeIndex.ttl`.
5. Update `index.ttl` to list all resources.

## Useful Commands

```bash
cascade pod info .           # Show Pod summary
cascade pod query . --all    # Query all data in the Pod
cascade pod export . --format zip   # Export as ZIP archive
cascade validate .           # Validate against SHACL shapes
```

## Learn More

- Cascade Protocol: https://cascadeprotocol.org
- Pod Structure Spec: https://cascadeprotocol.org/docs/spec/pod-structure
- Cascade SDK: https://github.com/nickthorpe71/cascade-sdk-swift
