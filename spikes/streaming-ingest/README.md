# Streaming-ingestion spike

A throwaway harness that proves streaming, not Rust, is the fix for multi-GB
health artifacts. It streams a large XML through a real SAX parser (`saxes`),
projects/downsamples as it parses, and reports peak RSS, time, and throughput.

Companion design doc: `cascade-assets/Cascade-documents/Cascade-Workbench/2026-06-26-ingestion-architecture-and-streaming-spike.md`.

## Run

```sh
npm i saxes        # standalone dep, intentionally not added to cascade-cli
node spike.mjs /path/to/large.xml
```

NDJSON projection samples go to stdout; the stats line goes to stderr.

## Results (2026-06-26, Node 22, Apple Health export, default heap)

| File | Size | Time | Throughput | Peak RSS |
|------|------|------|-----------|----------|
| `export_cda.xml` | 2.31 GB | 11.4 s | 202 MB/s | 159 MB |
| `export.xml` | 4.55 GB | 21.9 s | 207 MB/s | 150 MB |

The 4.5 GB file used *less* RAM than the 2.3 GB file: memory is independent of
file size, which is the signature of true streaming (we never hold the
document). 10.2M heart-rate samples downsampled to 3,061 daily summaries with no
memory growth.

## Conclusion

The decision gate passed decisively for streaming in TypeScript. Node is not the
bottleneck for multi-GB XML/JSON/FHIR/CCDA. Rust is deferred to the binary +
compute + extreme-scale tail (PDF/OCR, DICOM, genomics at tens-plus of GB),
measured against this ~205 MB/s baseline when such a file is actually in hand.
