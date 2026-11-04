import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";

/**
 * Salesforce field-definition metadata (CustomField.required=true) is the
 * authoritative repository signal for a universally required custom field.
 * Page-layout required flags and validation rules must NOT be interpreted as
 * universal requirements; they do not eliminate field-level security.
 *
 * Metadata is read on demand and cached for the life of the backend process.
 * Restart the API after changing field definitions in the repository.
 */
const parser = new XMLParser({ ignoreAttributes: true });
const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const requiredByField = new Map<string, boolean>();
const directoryEntries = new Map<string, Map<string, string>>();

function namesIn(directory: string): Map<string, string> {
  const key = path.resolve(directory);
  let names = directoryEntries.get(key);
  if (names) return names;
  names = new Map();
  try {
    for (const entry of readdirSync(key, { withFileTypes: true })) {
      names.set(entry.name.toLowerCase(), entry.name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  directoryEntries.set(key, names);
  return names;
}

/**
 * True only if the object/field XML explicitly declares <required>true</required>.
 * Missing metadata is NOT evidence that a field is universally required.
 */
export function isSchemaRequiredField(
  objectsDirectory: string | undefined,
  objectName: string,
  fieldName: string
): boolean {
  if (!objectsDirectory || !namePattern.test(objectName) || !namePattern.test(fieldName)) return false;
  const base = path.resolve(objectsDirectory);
  const cacheKey = `${base.toLowerCase()}|${objectName.toLowerCase()}|${fieldName.toLowerCase()}`;
  const cached = requiredByField.get(cacheKey);
  if (cached !== undefined) return cached;

  const resolvedObject = namesIn(base).get(objectName.toLowerCase());
  if (!resolvedObject) {
    requiredByField.set(cacheKey, false);
    return false;
  }
  const fieldsDirectory = path.join(base, resolvedObject, "fields");
  const fileName = namesIn(fieldsDirectory).get(`${fieldName}.field-meta.xml`.toLowerCase());
  if (!fileName) {
    requiredByField.set(cacheKey, false);
    return false;
  }

  let required = false;
  try {
    const xml = readFileSync(path.join(fieldsDirectory, fileName), "utf8");
    const metadata = parser.parse(xml)?.CustomField;
    required = metadata?.required === true || String(metadata?.required).trim().toLowerCase() === "true";
  } catch (error) {
    throw new Error(`Unable to read required-field metadata for ${objectName}.${fieldName}: ${String(error)}`);
  }
  requiredByField.set(cacheKey, required);
  return required;
}
