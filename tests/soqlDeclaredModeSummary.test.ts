import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { countDeclaredSoqlModes } from "../src/analyzer/soqlDeclaredModeSummary.js";
import { extractSoqlQueries } from "../src/scanner/apexSoqlScanner.js";
import { SoqlAnalysisService } from "../src/services/SoqlAnalysisService.js";
import type { SoqlSecurityAnalyzer } from "../src/analyzer/soqlSecurityAnalyzer.js";
import type { Persona } from "../src/models/Persona.js";

const apexSource = [
  "public class ModeQueries {",
  "  public static void run() {",
  "    List<Account> u = [SELECT Id FROM Account WITH USER_MODE];",
  "    List<Account> e = [SELECT Id FROM Account WITH SECURITY_ENFORCED];",
  "    List<Account> s = [SELECT Id FROM Account WITH SYSTEM_MODE];",
  "    List<Account> n = [SELECT Id FROM Account];",
  "    List<Account> literal = [SELECT Id FROM Account WHERE Name = 'WITH USER_MODE'];",
  "  }",
  "}",
].join("\n");

const expectedCounts = {
  userModeQueries: 1,
  securityEnforcedQueries: 1,
  systemModeQueries: 1,
  unspecifiedModeQueries: 2,
};

test("four declared SOQL mode counters are exclusive and cover every scanned query", () => {
  const queries = extractSoqlQueries(apexSource, "classes/ModeQueries.cls");
  assert.equal(queries.length, 5);
  assert.deepEqual(countDeclaredSoqlModes(queries), expectedCounts);
  assert.equal(Object.values(countDeclaredSoqlModes(queries)).reduce((a, b) => a + b, 0), queries.length);
});

test("mode counting handles an empty analysis without guessing a runtime default", () => {
  assert.deepEqual(countDeclaredSoqlModes([]), {
    userModeQueries: 0,
    securityEnforcedQueries: 0,
    systemModeQueries: 0,
    unspecifiedModeQueries: 0,
  });
});

test("SOQL analysis API summary exposes the four counts without changing Excel output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-soql-mode-summary-"));
  try {
    await writeFile(path.join(root, "ModeQueries.cls"), apexSource, "utf8");
    // Permission findings are intentionally orthogonal to declared query mode.
    const analyzer = { analyze: async () => [] } as unknown as SoqlSecurityAnalyzer;
    const service = new SoqlAnalysisService(root, analyzer, path.join(root, "reports"));
    const result = await service.analyze({ name: "OMS Specialist" } as Persona);

    assert.equal(result.summary.queriesAnalyzed, 5);
    assert.equal(result.summary.totalFindings, 0);
    for (const [key, value] of Object.entries(expectedCounts)) {
      assert.equal(result.summary[key as keyof typeof expectedCounts], value, key);
    }
    assert.equal("noUserModeQueries" in result.summary, false);
    assert.equal((await readFile(result.reports.summaryReportPath)).length > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
