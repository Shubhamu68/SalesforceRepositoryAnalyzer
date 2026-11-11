# Configure XLSX and TXT report output

The backend API (`npm run api`), interactive CLI (`npm run analyze`) and scoped CLI
(`npm run soql:scope`) now all use `SALESFORCE_ANALYZER_OUTPUT_DIRECTORY`.

## Configuration

Copy `.env.example` to `.env` at the Analyzer project root and edit:

```properties
SALESFORCE_REPOSITORY_PATH=C:/Work/SalesforceRepo
SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=C:/Users/YourUser/Desktop/SalesforceAnalyzerOutputReports
```

Windows accepts forward slashes in this setting; backslashes also work when unquoted.
To save reports inside the Analyzer directory instead:

```properties
SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=reports
```

If the variable is missing or empty, the default is `./reports` relative to the
process working directory. Start `npm run api` from the project root so that
relative paths resolve as expected.

Reports include:
- `soql-fls-<persona>-<timestamp>-summary.xlsx`
- `soql-fls-<persona>-<timestamp>-errors.txt`
- `soql-fls-<persona>-<timestamp>-other.txt`
- `soql-scope-result.json` for the scoped CLI

The analyzer creates the output directory automatically. This setting changes
only **where** reports are written, not their format, contents or permission rules.

## Override for the scoped CLI

```powershell
npm run soql:scope -- --repository . --persona "Master Data Specialist" --mode FULL --output ./my-run
```

The explicit `--output` takes precedence over the .env setting for that run.

## Important

- Report output is not an Excel workbook template path. It must be a **folder**.
- The API loads `.env` on startup; restart `npm run api` after changing it.
- Do not commit `.env`; only `.env.example` is safe to share.
- A desktop package will need its own user-data/output path strategy; it has
  **not** been implemented by this configuration change.
