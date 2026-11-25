import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { writeSoqlReport } from '../src/reporter/soqlReportWriter.js';
import type { SoqlSecurityFinding } from '../src/models/SoqlSecurityFinding.js';

const shared = {
  severity: 'ERROR', criticality: 'High', verificationSource: 'ORG_DENIED', findingType: 'OBJECT_READ',
  object: 'ApexEmailNotification', field: '(Object Read Missing)', query: 'SELECT Id FROM ApexEmailNotification',
  withUserMode: false, reason: 'Salesforce confirmed Read access is missing',
} as const;
test('Excel summary has one sheet and 8 columns, retaining mixed-mode risk warnings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-mode-excel-'));
  try {
    const findings: SoqlSecurityFinding[] = [
      { ...shared, criticality: 'Low', severity: 'INFO', filePath: '/repo/Old.cls', lineNumber: 10, apiVersion: 66,
        reason: 'Denied Read, but system-mode query does not enforce it.',
        declaredMode: 'UNSPECIFIED', effectiveMode: 'SYSTEM_MODE', runtimeImpact: 'Not enforced by query' },
      { ...shared, filePath: '/repo/New.cls', lineNumber: 20, apiVersion: 67,
        reason: 'Denied Read with user-mode enforcement.',
        declaredMode: 'UNSPECIFIED', effectiveMode: 'USER_MODE', runtimeImpact: 'Potential access failure' },
    ];
    const paths = await writeSoqlReport(dir, 'Test', 2, findings);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(paths.summaryReportPath);
    const summary = workbook.getWorksheet('Summary')!;
    assert.equal(summary.getCell('E6').value, 'Criticality / Severity');
    assert.equal(summary.getCell('G6').value, 'Runtime Impact');
    assert.equal(summary.getCell('H6').value, 'Effective Query Mode');
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Summary']);
    assert.equal(summary.columnCount, 8);
    assert.equal(summary.getCell('I6').value, null);
    assert.equal(summary.getCell('J6').value, null);
    assert.equal(summary.getCell('K6').value, null);
    assert.equal(summary.getCell('E7').value, 'High');
    assert.equal(summary.getCell('C7').value, 2);
    assert.equal(summary.getCell('G7').value, 'Mixed');
    assert.equal(summary.getCell('H7').value, 'Mixed');
    assert.match(String(summary.getCell('F7').value), /Severity differs across SOQL queries/);
    assert.doesNotMatch(String(summary.getCell('F7').value), /see References/i);
    assert.deepEqual(Object.keys(paths), ['summaryReportPath']);
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(dir), [path.basename(paths.summaryReportPath)]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('Review and High severity cells use identical red text without changing classification', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-review-excel-'));
  try {
    const findings: SoqlSecurityFinding[] = [
      { ...shared, filePath: '/repo/High.cls', lineNumber: 10 },
      { ...shared, object: 'Dynamic SOQL', field: '(Security mode conflict: Review.cls:20)', filePath: '/repo/Review.cls', lineNumber: 20,
        severity: 'REVIEW', criticality: 'Unable to verify', verificationSource: 'UNVERIFIED', findingType: 'QUERY_MODE',
        reason: 'REVIEW — WITH SECURITY_ENFORCED conflicts with AccessLevel.SYSTEM_MODE.', effectiveMode: 'UNKNOWN', runtimeImpact: 'Undetermined' },
      { ...shared, object: 'Contact', filePath: '/repo/Low.cls', lineNumber: 30, severity: 'INFO', criticality: 'Low' },
    ];
    const paths = await writeSoqlReport(dir, 'Test', 2, findings);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(paths.summaryReportPath);
    const sheet = workbook.getWorksheet('Summary')!;
    assert.equal(sheet.getCell('E7').value,'High');
    assert.equal(sheet.getCell('E8').value,'Unable to verify');
    assert.equal(sheet.getCell('E7').font.color?.argb,'FFB42332');
    assert.equal(sheet.getCell('E8').font.color?.argb,sheet.getCell('E7').font.color?.argb);
    assert.match(String(sheet.getCell('F8').value),/WITH SECURITY_ENFORCED.*AccessLevel\.SYSTEM_MODE/);
    assert.equal(sheet.getCell('E9').font.color?.argb,'FF167349');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
