import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { resolveReportOutputDirectory } from "../src/config/reportOutputDirectory.js";

const cwd = path.resolve("workspace-root");

test("report folder defaults to reports when environment variable is not set", () => {
  assert.equal(resolveReportOutputDirectory(undefined, cwd), path.join(cwd, "reports"));
});
test("empty/whitespace output directory uses default", () => {
  assert.equal(resolveReportOutputDirectory("  ", cwd), path.join(cwd, "reports"));
});
test("relative output directory is resolved against application working directory", () => {
  assert.equal(resolveReportOutputDirectory("output/SF Reports", cwd),
    path.resolve(cwd, "output/SF Reports"));
});
test("absolute output directory is preserved", () => {
  const absolute = path.resolve("temporary", "salesforce-reports");
  assert.equal(resolveReportOutputDirectory(absolute, cwd), absolute);
});
test("environment variable is used by default", () => {
  const previous = process.env.SALESFORCE_ANALYZER_OUTPUT_DIRECTORY;
  try {
    process.env.SALESFORCE_ANALYZER_OUTPUT_DIRECTORY = "custom-reports";
    assert.equal(resolveReportOutputDirectory(undefined, cwd), path.join(cwd, "custom-reports"));
  } finally {
    if (previous === undefined) delete process.env.SALESFORCE_ANALYZER_OUTPUT_DIRECTORY;
    else process.env.SALESFORCE_ANALYZER_OUTPUT_DIRECTORY = previous;
  }
});
test("null characters in configured directory are rejected", () => {
  assert.throws(() => resolveReportOutputDirectory("reports\0bad", cwd), /null character/);
});
