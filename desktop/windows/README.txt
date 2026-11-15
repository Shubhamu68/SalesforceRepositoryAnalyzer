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

CONFIGURATION (in .env, beside Start Analyzer.cmd)
SALESFORCE_REPOSITORY_PATH=C:/Your/Local/SalesforceRepo
SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=C:/Users/You/Documents/AnalyzerReports
SALESFORCE_LOGIN_URL=https://test.salesforce.com
SALESFORCE_API_VERSION=v62.0
SALESFORCE_CLIENT_ID=your-approved-app-client-id
SALESFORCE_CLIENT_SECRET=your-own-authorized-secret

- Repo/output paths are machine-specific. Do not copy another user's paths.
- A configured path is reused only if it still passes validation.
- Missing credentials allow repository-only checks after the existing warning.
  Invalid credentials may block org-dependent SOQL/Stack analyses as before.
- Only the local machine's loopback address is used. No external server needed.
- Do not rename or move files inside the extracted distribution.
- Windows PowerShell and interactive desktop access are needed for the existing
  native folder selection dialogs.
- No Node.js/npm/VS Code installation is required on recipients' machines.
- If the Windows company security policy blocks unsigned batch files or the
  bundled runtime, seek IT approval rather than bypassing security controls.

SECURITY
DO NOT publish Salesforce client secrets in Git, GitHub Actions, or the
distributed ZIP. This build contains only a blank .env.example. Supply each
authorized user with credentials by an approved secure channel, or use a
separate properly scoped integration for your team.
The user who receives a client secret can extract and reuse it; this is
not a secure end-user OAuth authentication mechanism.

For a native standalone desktop window in a later version, an Electron shell
can replace the browser launcher without rewriting the analyzer features.
