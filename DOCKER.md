# cascade-protocol/tools Docker Image

Run the Cascade Protocol CLI without installing Node.js. The image is not published to a
registry; build it from this repository.

## Build

```bash
docker build -t cascade-protocol/tools .
```

## Usage

The image's entrypoint is the CLI itself, so arguments start at the command name (`validate`,
`pod`, ...), with no leading `cascade`. Mount the folder holding your files at `/data` and refer
to them through it.

```bash
# Validate a Turtle file
docker run --rm -v "$(pwd)":/data cascade-protocol/tools validate /data/record.ttl

# Query a local Pod
docker run --rm -v "$(pwd)/my-pod":/data cascade-protocol/tools pod query /data --all

# Convert FHIR to Cascade Turtle
docker run --rm -v "$(pwd)":/data cascade-protocol/tools convert --from fhir --to cascade /data/patient.json

# Any command's help
docker run --rm cascade-protocol/tools --help
```

For an encrypted Pod, pass the passphrase through the environment:
`docker run --rm -e CASCADE_POD_PASSPHRASE -v ...`.

## Image details

- Base: `node:18-alpine`, multi-stage build; only the built `dist/` and production dependencies
  ship in the final image
- Runs as the non-root user `cascade`

## Security

- The container sees only the folders you mount
- No telemetry or analytics
- The same network rules as the CLI apply: no command contacts a network to convert, validate,
  import, query or write. `advisory feed pull`, `pod extract` and `agent` are the exceptions, and
  only when you run them (see the [README](README.md))
