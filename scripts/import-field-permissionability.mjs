import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// Explicit source org ID prevents an unrelated project's field export from
// silently becoming the Analyzer's shared metadata. This is a manual,
 // repository-independent cache; do NOT commit it.
const args = process.argv.slice(2);
const at = args.indexOf("--org-id");
const organizationId = at < 0 ? "" : args[at + 1] ?? "";
if (!/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(organizationId)) {
  throw new Error("Provide the source Salesforce organization ID with --org-id 00D... (15 or 18 characters).");
}
const positional = args.filter((argument, index) => index !== at && index !== at + 1);
const input = path.resolve(positional[0] ?? "config/field-permissionability.csv");
const output = path.resolve(positional[1] ?? "config/field-permissionability.local.json");
const source = readFileSync(input, "utf8").replace(/^\uFEFF/, "");

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && ch === ',') {
      row.push(cell); cell = "";
    } else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (quoted) throw new Error("Malformed CSV: unterminated quoted field");
  row.push(cell);
  if (row.some((value) => value.length)) rows.push(row);
  return rows;
}

const rows = parseCsv(source);
const expected = ["EntityDefinition.QualifiedApiName", "QualifiedApiName", "IsPermissionable"];
if (rows[0]?.join("|") !== expected.join("|")) throw new Error("Unexpected EntityParticle CSV header");
const objects = {};
const keys = new Set();
for (const [index, row] of rows.slice(1).entries()) {
  if (row.length !== 3) throw new Error(`Row ${index + 2}: expected exactly 3 columns`);
  const [objectName, fieldName, raw] = row.map((value) => value.trim());
  const value = raw.toLowerCase();
  if (!objectName || !fieldName || !["true", "false"].includes(value)) {
    throw new Error(`Row ${index + 2}: invalid object, field or IsPermissionable value`);
  }
  const key = `${objectName}.${fieldName}`.toLowerCase();
  if (keys.has(key)) throw new Error(`Duplicate field: ${objectName}.${fieldName}`);
  keys.add(key);
  (objects[objectName] ??= {})[fieldName] = value === "true";
}
if (!keys.size) throw new Error("The snapshot contains no fields");
const sortedObjects = Object.fromEntries(
  Object.entries(objects)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([object, fields]) => [object, Object.fromEntries(
      Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))
    )])
);
const snapshot = {
  version: 2,
  organizationId,
  capturedAt: new Date().toISOString(),
  objects: sortedObjects,
};
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(snapshot, null, 2) + "\n");
console.log(`Wrote ${keys.size} fields across ${Object.keys(objects).length} objects to ${output} for org ${organizationId.slice(0, 15)}`);
