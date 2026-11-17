SALESFORCE REPOSITORY ANALYZER - WINDOWS PORTABLE
=================================================

START (Windows 10/11)
1. Extract the COMPLETE ZIP to a local writable folder.
   Do not run Start Analyzer.cmd directly from inside the ZIP.
2. Double-click "Start Analyzer.cmd". The launcher opens your default browser.
   A small console window remains open to host the local API; close it when done.
3. If a .env file does not exist, it is created from .env.example automatically.
4. If the repository path is missing or invalid, the existing first-run dialog
   asks you to choose the Salesforce repository ROOT folder, containing
   force-app/main/default with Apex/permissions metadata. It validates the
   selection and stores the result in the root .env file.
5. The first SOQL Security Analysis requiring an Excel report will ask you
   to choose a valid, writable report output folder, if not configured.

AUTHENTICATION AND CONFIGURATION
- Salesforce CLI (sf) must be installed and available in PATH on each user's
  Windows machine; Node/npm and VS Code remain unnecessary for the portable app.
- On the first screen choose an authorized CLI org, or choose "Log in to
  Sandbox" / "Log in to Production" to open Salesforce's regular browser login.
- Enter your Salesforce username/password only on Salesforce's official login
  page (including SSO and MFA). Never type passwords into this Analyzer.
- Previously authorized CLI orgs are available for selection, but expired
  authorizations require browser reauthentication.
- Logout/Disconnect in the Analyzer does NOT remove CLI credentials shared
  with Salesforce CLI and VS Code.
- You can choose Continue repository-only when no org connection is needed.

CONFIGURATION (.env beside Start Analyzer.cmd)
SALESFORCE_REPOSITORY_PATH=C:/Your/Local/SalesforceRepo
SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=C:/Users/You/Documents/AnalyzerReports
SALESFORCE_API_VERSION=v62.0

- Repo/output paths are machine-specific. Do not copy another user's paths.
- A configured path is reused only if it passes validation.
- Only local loopback is used for the Analyzer browser/API; the Salesforce
  login browser page connects directly to Salesforce's secure HTTPS origin.
- Windows PowerShell and interactive desktop access are needed for the folder
  selection dialogs.
- No standalone Node.js/npm installation is required on recipients' machines.
- Corporate endpoint policies might restrict CLI/browser login. Obtain IT
  approval rather than bypassing controls.

SECURITY
The Analyzer does not require or distribute a custom Salesforce OAuth app,
client ID or client secret. CLI manages individual OAuth authorizations.
The Analyzer accesses only the chosen org and keeps its short-lived access
token in backend process memory. The ZIP contains only a safe .env.example.
Never share CLI auth files, auth URLs, tokens, customer data or screenshots
containing live org records.

For a native standalone desktop window in a later version, an Electron shell
can replace the browser launcher without rewriting the analyzer features.
