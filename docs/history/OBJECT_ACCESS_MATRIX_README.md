# Object Access Matrix — apply and test

## What this ZIP contains

It contains **only new or changed files**, at the same relative paths as your `salesforce-repository-analyzer` project. Existing files not listed here remain untouched.

- `src/models/ObjectAccessMatrixResult.ts` — matrix response model
- `src/models/PermissionSetGroup.ts` — retains muting Permission Set names defined in PSG metadata
- `src/parser/permissionSetGroupParser.ts` — parses `<mutingPermissionSets>` from PSG XML
- `src/services/ObjectAccessMatrixService.ts` — compares all personas for one object, with PSG-scoped muting and source provenance
- `src/api/server.ts` — adds `GET /api/objects/:objectName/persona-access`
- `web/src/components/ObjectAccessMatrix.tsx` — matrix page with a detailed-view toggle
- `web/src/App.tsx` — enables Object Access Matrix in sidebar navigation
- `web/src/App.css` — new matrix styles
- `tests/objectAccessMatrix.test.ts` — focused permission matrix tests
- `package.json` — adds `test:matrix` script (no new npm dependencies)

## Apply

1. Make sure your current branch is `feature/object-access-matrix` and commit or stash any other local changes.
2. Extract the ZIP **into the root** `C:\Users\703394232\salesforce-repository-analyzer`, merging folders and replacing the files listed above.
3. Run from the repository root:

   ```powershell
   npm run build
   npm run test:matrix
   npm run api
   ```

4. Open a **second terminal**:

   ```powershell
   cd web
   npm run build
   npm run dev
   ```

5. Open `http://localhost:5173`, choose **Object Access Matrix**, enter `Account`, and click **Run Access Matrix**.
6. Click **Detailed View** at the top right of the results. Expand a persona to see per-permission contributing PS/PSG sources and relevant mutes.

## API smoke test

Once the API is running, open this URL in a browser:

`http://localhost:3000/api/objects/Account/persona-access`

Expect JSON containing `object`, `totalPersonas`, `personasWithRead`, `personas`, and `warnings`.

## Important accuracy notes

- The matrix covers the seven object permissions requested: Read, Create, Edit, Delete, View All Records, Modify All Records, and View All Fields.
- It reads the **configured personas and local metadata**, not a live Salesforce org. Profile/system permission grants and record sharing are out of scope.
- Muting Permission Sets affect **only their own PSG**; direct grants and other PSGs can still provide the permission. The matrix uses a group association from the `<mutingPermissionSets>` elements in each PSG XML file.
- If a PSG XML omits the muting reference and the persona has just **one PSG**, its explicit `mutingPermissionSets` config acts as a fallback. If multiple PSGs are configured and a mute cannot be associated, the API returns a warning instead of silently applying it to all groups.
- The backend resolver currently logs missing/unparseable metadata and skips those entries. This matrix also surfaces warnings for such missing grants so a user knows the result may be incomplete.
- The matrix uses group-aware scoped muting; the existing single-persona Object Access and SOQL views have *not* been refactored in this delivery. They retain their current engine behavior.
- If an object is absent from all configured grants, each persona shows `No`; this does not prove the object is absent from Salesforce.

## Verify expected behavior

- Account appears with one row per persona defined in `config/personas.json`.
- View All Records / Modify All Records / View All Fields all show source PS/PSG in Detailed View when granted.
- A permission muted in one group can still be granted by a different group or direct Permission Set.
- Searching personas filters rows and their detailed breakdown.
- Object Access Checker, Field Access Checker, SOQL Security Analysis, and Reports remain available.
