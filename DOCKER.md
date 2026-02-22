# cascade-protocol/tools Docker Image

Run the Cascade Protocol CLI without installing Node.js.

## Quick Start

```bash
# Validate a Turtle file
docker run --rm -v $(pwd):/data cascade-protocol/tools cascade validate /data/record.ttl

# Query a local Pod
docker run --rm -v ./my-pod:/data cascade-protocol/tools cascade pod query --all /data

# Convert FHIR to Cascade
docker run --rm -v $(pwd):/data cascade-protocol/tools cascade convert --from fhir --to cascade /data/patient.json
```

## Build Locally

```bash
docker build -t cascade-protocol/tools .
```

## Image Details

- Base: node:18-alpine
- Architecture: amd64, arm64
- Size: ~80MB
- Runs as non-root user (cascade)

## Security

- No network calls during operation (data stays local)
- Runs as non-root user
- No telemetry or analytics
- Zero-knowledge: the image has no access to your data unless you explicitly mount a volume
