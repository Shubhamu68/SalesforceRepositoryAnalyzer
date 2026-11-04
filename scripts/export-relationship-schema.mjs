/**
 * Export relationship metadata using Salesforce CLI authentication.
 * This is a one-time local/offline snapshot; no credentials are stored.
 * Example: npm run export:relationships -- --org AnalyzerSandbox --objects OrderItemSummary,Product2,OrderSummary,OrderItem,Order,Account,User
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const param = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const org = param('--org');
const objectsOption = param('--objects');
if (!org || !objectsOption) {
  console.error('Usage: npm run export:relationships -- --org <SalesforceOrgAlias> --objects OrderItemSummary,OrderSummary,Product2,OrderItem,Order,Account,User');
  process.exit(1);
}
if (!/^[A-Za-z0-9_.@-]+$/.test(org)) throw new Error('Invalid Salesforce org alias.');
const objectNames = [...new Set(objectsOption.split(',').map(s => s.trim()).filter(Boolean))];
if (objectNames.some(name => !/^[A-Za-z_]\w*$/.test(name))) throw new Error('Invalid Salesforce object name.');
const objects = {};
for (const name of objectNames) {
  process.stdout.write(`Describing ${name} ... `);
  const cmd = spawnSync('sf', ['sobject', 'describe', '--sobject', name, '--target-org', org, '--json'], {
    encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 15 * 1024 * 1024, timeout: 90000,
  });
  if (cmd.error || cmd.status !== 0) {
    console.error('FAILED');
    console.error(`Could not describe ${name}. Verify sf login and access to the object.`);
    if (cmd.error) console.error(cmd.error.message);
    process.exit(1);
  }
  let response;
  try { response = JSON.parse(cmd.stdout); }
  catch { throw new Error(`Invalid JSON returned by Salesforce CLI for ${name}`); }
  const result = response.result;
  if (!result || !Array.isArray(result.fields) || !Array.isArray(result.childRelationships)) {
    throw new Error(`Unexpected Salesforce describe result for ${name}`);
  }
  objects[name] = {
    parents: result.fields
      .filter(f => f.relationshipName && Array.isArray(f.referenceTo) && f.referenceTo.length)
      .map(f => ({ relationshipName: f.relationshipName, sourceField: f.name, referenceTo: f.referenceTo })),
    children: result.childRelationships
      .filter(c => c.relationshipName && c.childSObject)
      .map(c => ({ relationshipName: c.relationshipName, childObject: c.childSObject, sourceField: c.field || '' })),
  };
  console.log(`${objects[name].parents.length} parent, ${objects[name].children.length} child relationships`);
}
const output = path.resolve('config', 'relationship-schema.json');
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ version: 1, source: 'Salesforce sObject Describe', objects }, null, 2) + '\n');
console.log(`Saved ${Object.keys(objects).length} objects to ${output}`);
