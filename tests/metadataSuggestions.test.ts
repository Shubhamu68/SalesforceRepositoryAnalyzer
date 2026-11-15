import assert from "node:assert/strict";
import { test } from "node:test";
import { filterMetadataSuggestions } from "../web/src/utils/metadataSuggestions.js";

test("object suggestions include every available name instead of only the first 20", () => {
  const objects = Array.from({ length: 145 }, (_, index) =>
    "Object_" + String(index).padStart(3, "0") + "__c"
  );
  assert.deepEqual(filterMetadataSuggestions(objects, ""), objects);
  assert.equal(filterMetadataSuggestions(objects, "").length, 145);
  assert.equal(filterMetadataSuggestions(objects, "  ").at(-1), "Object_144__c");
});

test("matching suggestions after the twentieth entry remain searchable", () => {
  const objects = Array.from({ length: 110 }, (_, index) =>
    "Client_Object_" + String(index).padStart(3, "0") + "__c"
  );
  const results = filterMetadataSuggestions(objects, "  object_10  ");
  assert.deepEqual(results, objects.slice(100));
  assert.equal(filterMetadataSuggestions(objects, "OBJECT_109__C").at(0), "Client_Object_109__c");
});

test("field suggestions also have no arbitrary limit and preserve repository order", () => {
  const fields = Array.from({ length: 230 }, (_, index) =>
    "Custom_Field_" + String(index).padStart(3, "0") + "__c"
  );
  assert.equal(filterMetadataSuggestions(fields, "").length, 230);
  assert.deepEqual(filterMetadataSuggestions(fields, "FIELD_22"), fields.slice(220, 230));
  assert.deepEqual(fields.slice(0, 2), ["Custom_Field_000__c", "Custom_Field_001__c"]);
  assert.deepEqual(filterMetadataSuggestions([], "Any"), []);
});
