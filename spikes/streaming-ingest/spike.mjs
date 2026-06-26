// Streaming-ingestion spike. Streams a multi-GB health XML through a real SAX
// parser, projects/extracts as it goes, and reports peak RSS, time, throughput.
// The whole point: prove memory stays FLAT regardless of file size (no whole-file
// read, no whole-document tree). Run with default heap (no --max-old-space-size)
// so a passing run proves we never accumulate.
import { createReadStream, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { SaxesParser } from "saxes";

const file = process.argv[2];
const size = statSync(file).size;
const t0 = Date.now();

let peakRss = 0;
const sampleRss = () => {
  const r = process.memoryUsage().rss;
  if (r > peakRss) peakRss = r;
};
const rssTimer = setInterval(sampleRss, 200);

const parser = new SaxesParser({ fileName: file });
let elements = 0,
  records = 0,
  observations = 0,
  entries = 0,
  saxErrors = 0;
const hrDaily = new Map(); // Apple Health: heart-rate downsampled to per-day.
let emitted = 0;
const emit = (obj) => {
  if (emitted < 4) {
    process.stdout.write(JSON.stringify(obj) + "\n");
    emitted++;
  }
};

parser.on("opentagstart", () => {
  elements++;
});
parser.on("opentag", (node) => {
  const n = node.name;
  if (n === "Record") {
    records++;
    const a = node.attributes;
    if (a.type === "HKQuantityTypeIdentifierHeartRate") {
      const day = (a.startDate || a.creationDate || "").slice(0, 10);
      const v = parseFloat(a.value);
      if (day && !Number.isNaN(v)) {
        let d = hrDaily.get(day);
        if (!d) {
          d = { min: v, max: v, sum: 0, n: 0 };
          hrDaily.set(day, d);
        }
        d.min = Math.min(d.min, v);
        d.max = Math.max(d.max, v);
        d.sum += v;
        d.n++;
      }
    }
  } else if (n === "observation") {
    observations++;
  } else if (n === "entry") {
    entries++;
  }
});
parser.on("error", () => {
  saxErrors++;
});

const decoder = new StringDecoder("utf8");
const stream = createReadStream(file, { highWaterMark: 1 << 20 });
stream.on("data", (chunk) => parser.write(decoder.write(chunk)));
stream.on("end", () => {
  parser.write(decoder.end());
  parser.close();
  clearInterval(rssTimer);
  sampleRss();
  const secs = (Date.now() - t0) / 1000;
  // Demonstrate the projection output: a few downsampled HR days as NDJSON.
  let i = 0;
  for (const [day, d] of hrDaily) {
    if (i++ >= 4) break;
    emit({
      kind: "hr-daily-summary",
      day,
      min: d.min,
      max: d.max,
      avg: +(d.sum / d.n).toFixed(1),
      samples: d.n,
    });
  }
  console.error(
    JSON.stringify(
      {
        file: file.split("/").pop(),
        sizeGB: +(size / 1e9).toFixed(2),
        elements,
        records,
        observations,
        entries,
        hrDays: hrDaily.size,
        saxErrors,
        seconds: +secs.toFixed(1),
        throughputMBs: +(size / 1e6 / secs).toFixed(1),
        peakRssMB: +(peakRss / 1e6).toFixed(0),
      },
      null,
      2,
    ),
  );
});
stream.on("error", (e) => {
  clearInterval(rssTimer);
  console.error("STREAM ERROR:", e.code, e.message);
});
