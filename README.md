# @cascade-protocol/cli

Cascade Protocol CLI - Validate, convert, and manage health data.

## Installation

```bash
npm install -g @cascade-protocol/cli
```

Or use directly with npx:

```bash
npx @cascade-protocol/cli validate record.ttl
```

## Usage

```
cascade <command> [options]

Commands:
  validate      Validate Cascade data against SHACL shapes
  convert       Convert between health data formats
  pod           Manage Cascade Pod structures
  conformance   Run conformance test suite
  serve         Start local agent server
  capabilities  Show machine-readable tool descriptions

Flags:
  --help        Show help
  --version     Show version
  --verbose     Verbose output
  --json        Output results as JSON (machine-readable)
```

## Examples

```bash
cascade validate record.ttl
cascade convert --from fhir --to cascade patient.json
cascade pod init ./my-pod
cascade capabilities
```

## Development

```bash
npm install
npm run build
npm run dev -- --help
npm test
```

## License

Apache-2.0
