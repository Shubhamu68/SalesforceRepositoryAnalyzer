import { isDataAccessAnalysisObject, PLATFORM_EVENT_ANALYSIS_EXCLUSION_REASON } from "./utils/objectSelectionPolicy";
import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import ObjectAccessMatrix from "./components/ObjectAccessMatrix";
import PermissionIndicator from "./components/PermissionIndicator";
import type { PermissionEvidence } from "./components/permissionPresentation";
import StackTraceImpact from "./components/StackTraceImpact";
import SalesforceOrgConnection from "./components/SalesforceOrgConnection";
import SalesforceOrgLogin from "./components/SalesforceOrgLogin";
import AnalysisLoadingOverlay from "./components/AnalysisLoadingOverlay";
import ReportOutputSetupModal from "./components/ReportOutputSetupModal";
import RepositorySetupModal from "./components/RepositorySetupModal";
import OrgAnalysisWarningModal, { type AnalysisWarning } from "./components/OrgAnalysisWarningModal";
import { repositoryConnectionIndicator } from "./utils/repositoryConnectionIndicator";
import { filterMetadataSuggestions } from "./utils/metadataSuggestions";
import { WORKFLOW_COPY, analysisModeHint, reportOutputHint, repositorySetupMessage, orgPreflightMessage, salesforceConnectionLabel, type SalesforceConnectionState } from "./utils/uiMessaging";

type Persona = {
  name: string;
};

type ObjectReadEvidence = {
  source: "REPOSITORY" | "ORG_VERIFIED" | "ORG_DENIED" | "UNVERIFIED";
  readable: boolean;
  statusNeutral: boolean;
  message: string;
};

type ObjectAccessResult = {
  object: string;
  readEvidence?: ObjectReadEvidence;
  permissionEvidence?: Partial<Record<"read" | "create" | "edit" | "delete" | "viewAllRecords" | "modifyAllRecords" | "viewAllFields", PermissionEvidence>>;
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  viewAllRecords: boolean;
  modifyAllRecords: boolean;
  viewAllFields: boolean;
};

type PermissionSource = {
  permissionSet: string;
  type: "permissionSetGroup" | "directPermissionSet" | "profile";
  viaSystemPermission?: "ViewAllData" | "ModifyAllData";
  permissionSetGroup?: string;
};

type FieldAccessResult = {
  field: string;
  objectReadEvidence?: ObjectReadEvidence;
  fieldReadEvidence?: { outcome: "VERIFIED" | "DENIED" | "UNVERIFIED"; message: string };
  permissionEvidence?: Partial<Record<"read" | "edit", PermissionEvidence>>;
  read: boolean;
  edit: boolean;
  permissionable?: boolean;
  flsApplicable?: boolean;
  flsReason?: string;
  schemaRequired?: boolean;
  readGrantedBy: PermissionSource[];
  editGrantedBy: PermissionSource[];
  mutedBy: string[];
};

type SoqlAnalysisResult = {
  personaName: string;
  summary: {
    queriesAnalyzed: number;
    totalFindings: number;
    errors: number;
    reviews: number;
    affectedApexClasses: number;
    userModeQueries: number;
    noUserModeQueries: number;
  };
  outputFolder: string;
};

type CheckType = "object" | "field" | "soql";
type Page = "dashboard" | "access" | "soql" | "matrix" | "stack" | "reports" | "salesforce";

function App() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [objects, setObjects] = useState<string[]>([]);
  const [fields, setFields] = useState<string[]>([]);

  const [selectedPersona, setSelectedPersona] =
    useState("");

  const [checkType, setCheckType] =
    useState<CheckType>("object");

  const [objectName, setObjectName] =
    useState("");

  const [objectSearch, setObjectSearch] =
    useState("");

  const [fieldName, setFieldName] =
    useState("");

  const [fieldSearch, setFieldSearch] =
    useState("");

  const [showObjectOptions, setShowObjectOptions] =
    useState(false);

  const [showFieldOptions, setShowFieldOptions] =
    useState(false);

  const [result, setResult] = useState<
    | ObjectAccessResult
    | FieldAccessResult
    | SoqlAnalysisResult
    | null
  >(null);

  const [error, setError] = useState("");

  const [loadingPersonas, setLoadingPersonas] =
    useState(true);

  const [loadingObjects, setLoadingObjects] =
    useState(true);

  const [loadingFields, setLoadingFields] =
    useState(false);

  const [checking, setChecking] = useState(false);
  const [page, setPage] = useState<Page>("dashboard");
  const [repositoryName, setRepositoryName] = useState<string>("");
  const [apiConnected, setApiConnected] = useState(false);
  const [salesforceConnection, setSalesforceConnection] = useState<SalesforceConnectionState>("connecting");
  const [orgStatusChecked, setOrgStatusChecked] = useState(false);
  const [orgGateDismissed, setOrgGateDismissed] = useState(false);
  const [lastSoql, setLastSoql] = useState<SoqlAnalysisResult | null>(null);
  const [reportFolderModalOpen, setReportFolderModalOpen] = useState(false);
  const [reportFolderExplanation, setReportFolderExplanation] = useState("");
  const [reportFolderError, setReportFolderError] = useState("");
  const [choosingReportFolder, setChoosingReportFolder] = useState(false);
  const [lastRunAt, setLastRunAt] = useState<Date | null>(null);
  const [repoReady, setRepoReady] = useState(false);
  const [repoChecked, setRepoChecked] = useState(false);
  const [repoRevision, setRepoRevision] = useState(0);
  const [repoModalOpen, setRepoModalOpen] = useState(false);
  const [repoError, setRepoError] = useState("");
  const [repoCurrentPath, setRepoCurrentPath] = useState<string | null>(null);
  const [choosingRepo, setChoosingRepo] = useState(false);
  const [orgWarning, setOrgWarning] = useState<AnalysisWarning | null>(null);
  const orgWarningResolver = useRef<((confirmed: boolean) => void) | null>(null);


  useEffect(() => {
    let active = true;
    async function refreshApiConnection() {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        if (!response.ok) throw new Error("API unavailable");
        if (active) setApiConnected(true);
      } catch {
        if (active) setApiConnected(false);
      }
    }
    void refreshApiConnection();
    const interval = window.setInterval(() => { void refreshApiConnection(); }, 5000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    let active = true;
    async function refreshSalesforceConnection() {
      try {
        const response = await fetch("/api/salesforce/status", { cache: "no-store" });
        if (!response.ok) throw new Error("Salesforce status unavailable");
        const data: { connected?: boolean; connecting?: boolean; configured?: boolean } = await response.json();
        if (active) {
          setSalesforceConnection(data.connected ? "connected" : data.connecting ? "connecting" : data.configured ? "unavailable" : "not-configured");
          setOrgStatusChecked(true);
        }
      } catch {
        if (active) { setSalesforceConnection("unavailable"); setOrgStatusChecked(true); }
      }
    }
    void refreshSalesforceConnection();
    const interval = window.setInterval(() => { void refreshSalesforceConnection(); }, 5000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    // Do not overwrite an invalid-folder selection error while setup is open.
    if (repoModalOpen) return;
    let active = true;
    async function refreshRepositoryStatus() {
      try {
        const response = await fetch("/api/repository/status", { cache: "no-store" });
        if (!response.ok) throw new Error("Unable to check Salesforce repository configuration.");
        const status: { configured: boolean; reason?: string; message: string; directory: string | null; repositoryName: string | null } =
          await response.json();
        if (!active) return;
        setRepoReady(status.configured);
        setRepoChecked(true);
        setRepoModalOpen(!status.configured);
        setRepoCurrentPath(status.directory);
        setRepoError(status.configured ? "" : repositorySetupMessage(status.reason, status.message));
        setRepositoryName(status.configured ? (status.repositoryName || "") : "");
      } catch (cause) {
        if (!active) return;
        setRepoChecked(true);
        setRepoReady(false);
        setRepositoryName("");
        setRepoModalOpen(true);
        setRepoError(cause instanceof Error ? cause.message : "Unable to contact the Analyzer API.");
      }
    }
    void refreshRepositoryStatus();
    const interval = window.setInterval(() => { void refreshRepositoryStatus(); }, 5000);
    return () => { active = false; window.clearInterval(interval); };
  }, [repoModalOpen]);

  async function ensureRepositoryReady(): Promise<boolean> {
    try {
      const response = await fetch("/api/repository/status", { cache: "no-store" });
      if (!response.ok) throw new Error("Cannot check repository configuration.");
      const status: { configured: boolean; reason?: string; message: string; directory: string | null } = await response.json();
      if (!status.configured) {
        setRepoReady(false);
        setRepoChecked(true);
        setRepositoryName("");
        setRepoCurrentPath(status.directory);
        setRepoError(repositorySetupMessage(status.reason, status.message));
        setRepoModalOpen(true);
        return false;
      }
      setRepoReady(true);
      setRepoChecked(true);
      return true;
    } catch (cause) {
      setRepoReady(false);
      setRepoChecked(true);
      setRepositoryName("");
      setRepoError(cause instanceof Error ? cause.message : "Repository validation failed.");
      setRepoModalOpen(true);
      return false;
    }
  }

  async function chooseRepository(): Promise<void> {
    if (choosingRepo) return;
    setChoosingRepo(true);
    setRepoError("");
    try {
      const response = await fetch("/api/repository/choose", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const result: { saved?: boolean; cancelled?: boolean; directory?: string; repositoryName?: string; error?: string } =
        await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Invalid Salesforce repository folder.");
      if (result.cancelled) {
        setRepoError("No repository selected. Choose a valid Salesforce repository to continue.");
        return;
      }
      if (!result.saved || !result.directory) throw new Error("Could not save Salesforce repository selection.");
      setRepoReady(true);
      setRepoChecked(true);
      setRepoCurrentPath(result.directory);
      setRepositoryName(result.repositoryName || "Configured repository");
      setRepoModalOpen(false);
      setRepoRevision(value => value + 1);
      setObjects([]);
      setFields([]);
      setObjectName("");
      setFieldName("");
      setResult(null);
      setLastSoql(null);
    } catch (cause) {
      setRepoError(cause instanceof Error ? cause.message : "Unable to configure the Salesforce repository.");
    } finally { setChoosingRepo(false); }
  }

  async function preflightOrgVerification(): Promise<{ acknowledgeRepoOnly: boolean } | null> {
    try {
      const response = await fetch("/api/analysis/preflight", { cache: "no-store" });
      const payload: { mode?: string; warning?: string; error?: string; missing?: string[] } =
        await response.json().catch(() => ({}));
      if (!response.ok) {
        setOrgWarning({
          kind: "ERROR", title: "Salesforce connection unavailable",
          message: payload.error || "Selected Salesforce CLI session is unavailable. Reauthorize from the Salesforce Org page and retry.",
        });
        return null;
      }
      if (payload.mode === "REPOSITORY_ONLY") {
        const confirmed = await new Promise<boolean>(resolve => {
          orgWarningResolver.current = resolve;
          setOrgWarning({
            kind: "WARNING", title: "Salesforce verification not configured",
            message: orgPreflightMessage(payload.missing),
          });
        });
        return confirmed ? { acknowledgeRepoOnly: true } : null;
      }
      return { acknowledgeRepoOnly: false };
    } catch (cause) {
      setOrgWarning({
        kind: "ERROR", title: "Salesforce connection check failed",
        message: cause instanceof Error ? cause.message : "Unable to validate Salesforce connection.",
      });
      return null;
    }
  }

  function dismissOrgWarning(confirmed: boolean): void {
    const resolver = orgWarningResolver.current;
    orgWarningResolver.current = null;
    setOrgWarning(null);
    resolver?.(confirmed);
  }

  function navigate(next: Page) {
    setPage(next);
    setError("");
    if (next === "soql") {
      setCheckType("soql");
      setResult(null);
    } else if (next === "access") {
      if (checkType === "soql") setCheckType("object");
      setResult(null);
    }
  }


  useEffect(() => {
    async function loadPersonas() {
      try {
        const response =
          await fetch("/api/personas");

        if (!response.ok) {
          throw new Error(
            "Failed to load personas."
          );
        }

        const data: Persona[] =
          await response.json();

        setPersonas(data);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load personas."
        );
      } finally {
        setLoadingPersonas(false);
      }
    }

    if (repoReady) loadPersonas();
  }, [repoReady, repoRevision]);

  useEffect(() => {
    async function loadObjects() {
      try {
        const response =
          await fetch("/api/objects");

        if (!response.ok) {
          throw new Error(
            "Failed to load objects."
          );
        }

        const data: string[] =
          await response.json();

        setObjects(data.filter(isDataAccessAnalysisObject));
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load objects."
        );
      } finally {
        setLoadingObjects(false);
      }
    }

    if (repoReady) loadObjects();
  }, [repoReady, repoRevision]);

  useEffect(() => {
  if (!repoReady || !objectName) {
    return;
  }

  async function loadFields() {
    setLoadingFields(true);
    setFields([]);

    try {
      const response = await fetch(
        `/api/objects/${encodeURIComponent(
          objectName
        )}/fields`
      );

      if (!response.ok) {
        throw new Error(
          "Failed to load fields."
        );
      }

      const data: string[] =
        await response.json();

      setFields(data);
    } catch (err) {
      setFields([]);

      setError(
        err instanceof Error
          ? err.message
          : "Failed to load fields."
      );
    } finally {
      setLoadingFields(false);
    }
  }

  loadFields();
}, [objectName, repoReady, repoRevision]);

  // Show every matching metadata entry; the dropdown itself remains scrollable.
  const filteredObjects = useMemo(
    () => filterMetadataSuggestions(objects, objectSearch),
    [objects, objectSearch]
  );

  const filteredFields = useMemo(
    () => filterMetadataSuggestions(fields, fieldSearch),
    [fields, fieldSearch]
  );

  async function handleCheck(skipReportOutputCheck = false) {
    setError("");
    setResult(null);

    if (!selectedPersona) {
      setError("Please select a persona.");
      return;
    }

    if (
      checkType !== "soql" &&
      !objectName.trim()
    ) {
      setError("Please select an object.");
      return;
    }

    if (checkType !== "soql" && !isDataAccessAnalysisObject(objectName)) {
      setError(PLATFORM_EVENT_ANALYSIS_EXCLUSION_REASON);
      return;
    }

    if (
      checkType === "field" &&
      !fieldName.trim()
    ) {
      setError("Please select a field.");
      return;
    }

    setChecking(true);

    try {
      if (!(await ensureRepositoryReady())) return;
      let response: Response;

      if (checkType === "soql" && !skipReportOutputCheck) {
        const configurationResponse = await fetch("/api/report-output/status", { cache: "no-store" });
        if (!configurationResponse.ok) {
          throw new Error("Unable to check the report output folder. Ensure the local API is running.");
        }
        const configuration: { configured: boolean; reason?: string; message: string } = await configurationResponse.json();
        if (!configuration.configured) {
          setReportFolderExplanation(reportOutputHint(configuration.reason, configuration.message));
          setReportFolderError("");
          setReportFolderModalOpen(true);
          return;
        }
      }

      if (checkType === "soql") {
        const preflight = await preflightOrgVerification();
        if (!preflight) return;
        response = await fetch(
          "/api/soql-analysis",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify({
              personaName:
                selectedPersona,
              acknowledgeRepoOnly: preflight.acknowledgeRepoOnly,
            }),
          }
        );
      } else {
        const encodedPersona =
          encodeURIComponent(
            selectedPersona
          );

        const encodedObject =
          encodeURIComponent(
            objectName.trim()
          );

        let url =
          `/api/personas/${encodedPersona}/objects/${encodedObject}`;

        if (checkType === "field") {
          const encodedField =
            encodeURIComponent(
              fieldName.trim()
            );

          url += `/fields/${encodedField}`;
        }

        response = await fetch(url);
      }

      if (checkType === "soql" && response.status === 409) {
        const body: { code?: string; error?: string } = await response.json().catch(() => ({}));
        if (body.code === "REPORT_OUTPUT_NOT_CONFIGURED") {
          setReportFolderExplanation(reportOutputHint(undefined, body.error || "Choose a folder to save the Excel report."));
          setReportFolderError("");
          setReportFolderModalOpen(true);
          return;
        }
        throw new Error(body.error || "Unable to run SOQL analysis.");
      }

      if (response.status === 404) {
        setError(
          checkType === "object"
            ? "Object not found."
            : checkType === "field"
              ? "Field not found."
              : "Persona not found."
        );

        return;
      }

      if (!response.ok) {
        const body =
          await response.json().catch(
            () => null
          );

        throw new Error(
          body?.error ??
            "Unable to perform the check."
        );
      }

      const data =
        await response.json();

      setResult(data);
      if (checkType === "soql") {
        setLastSoql(data as SoqlAnalysisResult);
        setLastRunAt(new Date());
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to perform the access check."
      );
    } finally {
      setChecking(false);
    }
  }

  async function chooseReportFolderAndRun() {
    if (choosingReportFolder) return;
    setChoosingReportFolder(true);
    setReportFolderError("");
    try {
      const response = await fetch("/api/report-output/choose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data: { saved?: boolean; cancelled?: boolean; directory?: string; error?: string } =
        await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unable to open the Windows folder picker.");
      }
      if (data.cancelled) {
        setReportFolderError("No folder was selected. Choose a folder to continue, or cancel this analysis.");
        return;
      }
      if (!data.saved || !data.directory) {
        throw new Error("The output directory was not saved. Please try again.");
      }
      setReportFolderModalOpen(false);
      await handleCheck(true);
    } catch (error) {
      setReportFolderError(error instanceof Error ? error.message : "Unable to configure the report output folder.");
    } finally {
      setChoosingReportFolder(false);
    }
  }

  function renderObjectResult(access: ObjectAccessResult) {
    const permissions = [
      { label: "Read", key: "read" }, { label: "Create", key: "create" },
      { label: "Edit", key: "edit" }, { label: "Delete", key: "delete" },
      { label: "View All Records", key: "viewAllRecords" },
      { label: "Modify All Records", key: "modifyAllRecords" },
      { label: "View All Fields", key: "viewAllFields" },
    ] as const;
    return (
      <div className="result-card">
        <div className="result-header"><span className="result-type">OBJECT</span><h2>{access.object}</h2></div>
        <div className="permission-grid">
          {permissions.map(({ label, key }) => (
            <div className="permission-row" key={key}>
              <span>{label}</span>
              <PermissionIndicator granted={access[key]}
                evidence={access.permissionEvidence?.[key] ?? (key === "read" && access.readEvidence
                  ? { source: access.readEvidence.source, message: access.readEvidence.message }
                  : undefined)} />
            </div>
          ))}
        </div>
        {access.permissionEvidence && Object.keys(access.permissionEvidence).length > 0 && (
          <details className="source-section">
            <summary>Verification details</summary>
            {permissions.filter(({ key }) => access.permissionEvidence?.[key]).map(({ label, key }) =>
              <p key={key} className="muted"><strong>{label}:</strong> {access.permissionEvidence?.[key]?.message}</p>)}
          </details>
        )}
        {!access.permissionEvidence && access.readEvidence && (
          <p className="muted" role="status">{access.readEvidence.message}</p>
        )}
      </div>
    );
  }

  function renderFieldResult(
    access: FieldAccessResult
  ) {
    if (access.flsApplicable === false) {
      return (
        <div className="result-card">
          <div className="result-header"><span className="result-type">FIELD</span><h2>{access.field}</h2></div>
          <div className="permission-grid">
            <div className="permission-row"><span>Read FLS</span><strong className="status">N/A</strong></div>
            <div className="permission-row"><span>Edit FLS</span><strong className="status">N/A</strong></div>
          </div>
          <div className="source-section" role="status">
            <h3>Field FLS not applicable</h3>
            <p className="muted">{access.flsReason}</p>
          </div>
        </div>
      );
    }
    return (
      <div className="result-card">
        <div className="result-header">
          <span className="result-type">
            FIELD
          </span>

          <h2>{access.field}</h2>
        </div>

        <div className="permission-grid">
          <div className="permission-row">
            <span>Read</span>
            <PermissionIndicator granted={access.read}
              evidence={access.permissionEvidence?.read ?? (access.fieldReadEvidence
                ? { source: access.fieldReadEvidence.outcome === "VERIFIED" ? "ORG_VERIFIED" : access.fieldReadEvidence.outcome === "DENIED" ? "ORG_DENIED" : "UNVERIFIED", message: access.fieldReadEvidence.message }
                : access.objectReadEvidence ? { source: access.objectReadEvidence.source, message: access.objectReadEvidence.message } : undefined)} />
          </div>
          <div className="permission-row">
            <span>Edit</span>
            <PermissionIndicator granted={access.edit} evidence={access.permissionEvidence?.edit}/>
          </div>
        </div>
        {(access.permissionEvidence || access.objectReadEvidence || access.fieldReadEvidence) && (
          <details className="source-section">
            <summary>Verification details</summary>
            {access.permissionEvidence?.read && <p className="muted">Field Read: {access.permissionEvidence.read.message}</p>}
            {access.permissionEvidence?.edit && <p className="muted">Field Edit: {access.permissionEvidence.edit.message}</p>}
            {!access.permissionEvidence && access.objectReadEvidence && <p className="muted">Object Read: {access.objectReadEvidence.message}</p>}
            {!access.permissionEvidence && access.fieldReadEvidence && <p className="muted">Field Read: {access.fieldReadEvidence.message}</p>}
          </details>
        )}
        <div className="source-section">
          <h3>Read granted by</h3>

          {access.schemaRequired && (
            <p className="muted">
              Salesforce requires this field. Individual FLS grants are not needed; object access still applies.
            </p>
          )}
          {access.permissionable === false && !access.schemaRequired && access.read && (
            <p className="muted">
              Read follows object access; separate field FLS is not applicable.
            </p>
          )}
          {access.readGrantedBy.length === 0 ? (
            <p className="muted">
              {access.schemaRequired
                ? "Read follows object Read (universally required field)."
                : access.permissionable === false
                ? "No explicit field Read grant required."
                : "No repository grant found."}
            </p>
          ) : (
            access.readGrantedBy.map(
              (source, index) => (
                <div
                  className="source-item"
                  key={`read-${index}`}
                >
                  <strong>
                    {source.type === "profile" ? `Profile: ${source.permissionSet}` : source.permissionSet}
                  </strong>

                  {source.permissionSetGroup && (
                    <span>
                      PSG:{" "}
                      {
                        source.permissionSetGroup
                      }
                    </span>
                  )}
                </div>
              )
            )
          )}
        </div>

        <div className="source-section">
          <h3>Edit granted by</h3>

          {access.editGrantedBy.length === 0 ? (
            <p className="muted">
              {access.schemaRequired && access.edit
                ? "Edit follows object Edit (universally required field)."
                : "No repository grant found."}
            </p>
          ) : (
            access.editGrantedBy.map(
              (source, index) => (
                <div
                  className="source-item"
                  key={`edit-${index}`}
                >
                  <strong>
                    {source.type === "profile" ? `Profile: ${source.permissionSet}` : source.permissionSet}
                  </strong>

                  {source.permissionSetGroup && (
                    <span>
                      PSG:{" "}
                      {
                        source.permissionSetGroup
                      }
                    </span>
                  )}
                </div>
              )
            )
          )}
        </div>

        {access.mutedBy.length > 0 && (
          <div className="source-section">
            <h3>Muted by</h3>
            {access.mutedBy.map((source) => (
              <div className="source-item muted-source" key={source}>{source}</div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderSoqlResult(
    analysis: SoqlAnalysisResult
  ) {
    const summaryItems = [
      [
        "Queries Analysed",
        analysis.summary.queriesAnalyzed,
      ],
      [
        "Errors",
        analysis.summary.errors,
      ],
      [
        "Reviews",
        analysis.summary.reviews,
      ],
      [
        "Affected Classes",
        analysis.summary.affectedApexClasses,
      ],
      [
        "USER_MODE",
        analysis.summary.userModeQueries,
      ],
      [
        "No explicit USER_MODE",
        analysis.summary.noUserModeQueries,
      ],
    ];

    return (
      <div className="soql-result-layout">
        <div className="soql-success-banner" role="status" aria-live="polite">
          <div className="soql-success-icon" aria-hidden="true">✓</div>
          <div className="soql-success-copy">
            <span className="soql-success-eyebrow">SOQL ANALYSIS COMPLETE</span>
            <h3>Excel report saved for {analysis.personaName}</h3>
          </div>
          <div className="soql-success-actions">
            <span className="soql-output-label">Output folder</span>
            <strong className="path-text">{analysis.outputFolder}</strong>
            <button
              className="secondary-button"
              type="button"
              onClick={() => navigator.clipboard.writeText(analysis.outputFolder)}
            >
              Copy folder path
            </button>
          </div>
        </div>

        <div className="result-card">
          <div className="result-header">
            <span className="result-type">SUMMARY</span>

            <h2>{analysis.personaName}</h2>
          </div>

          <div className="permission-grid">
            {summaryItems.map(
              ([label, value]) => (
                <div
                  className="permission-row"
                  key={String(label)}
                >
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              )
            )}
          </div>
        </div>
      </div>
    );
  }

  const soqlSummary = lastSoql?.summary;

  const metricCards = [
    { label: "SOQL queries", value: soqlSummary?.queriesAnalyzed, icon: "⌕", tone: "blue" },
    { label: "Errors", value: soqlSummary?.errors, icon: "!", tone: "red" },
    { label: "Review findings", value: soqlSummary?.reviews, icon: "◉", tone: "amber" },
    { label: "Affected classes", value: soqlSummary?.affectedApexClasses, icon: "{ }", tone: "purple" },
    { label: "WITH USER_MODE", value: soqlSummary?.userModeQueries, icon: "✓", tone: "green" },
    { label: "No explicit USER_MODE", value: soqlSummary?.noUserModeQueries, icon: "!", tone: "amber" },
  ];

  const showSoqlOverlay = checking && page === "soql";

  const analysisForm = (
    <section className="panel analysis-panel">
      <div className="panel-heading">
        <div>
          <h2>{page === "soql" ? WORKFLOW_COPY.soql.heading : WORKFLOW_COPY.access.heading}</h2>
          <p>{page === "soql" ? WORKFLOW_COPY.soql.description : WORKFLOW_COPY.access.description}</p>
        </div>
        
      </div>
      <div className="analysis-fields">
        <div className="form-field">
          <label htmlFor="persona">Business persona</label>
          <select
            id="persona"
            value={selectedPersona}
            disabled={loadingPersonas || checking}
            onChange={(event) => {
              setSelectedPersona(event.target.value);
              setResult(null);
              setError("");
            }}
          >
            <option value="">{loadingPersonas ? "Loading personas…" : "Select a persona"}</option>
            {personas.map((persona) => (
              <option key={persona.name} value={persona.name}>{persona.name}</option>
            ))}
          </select>
        </div>
        {page === "access" && (
          <>
            <div className="form-field">
              <label>Access type</label>
              <div className="segmented" role="group" aria-label="Access type">
                <button type="button" className={checkType === "object" ? "selected" : ""} onClick={() => { setCheckType("object"); setResult(null); setError(""); }}>Object access</button>
                <button type="button" className={checkType === "field" ? "selected" : ""} onClick={() => { setCheckType("field"); setResult(null); setError(""); }}>Field access</button>
              </div>
            </div>
            <div className="form-field">
              <label htmlFor="object-name">Object API name</label>
              <div className="autocomplete">
                <input
                  id="object-name"
                  type="text"
                  value={objectSearch}
                  autoComplete="off"
                  onFocus={() => setShowObjectOptions(true)}
                  onChange={(event) => {
                    const value = event.target.value;
                    setObjectSearch(value);
                    setObjectName(value);
                    setShowObjectOptions(true);
                    setFieldName("");
                    setFieldSearch("");
                    setResult(null);
                    setError("");
                  }}
                  onBlur={() => window.setTimeout(() => setShowObjectOptions(false), 150)}
                  placeholder={loadingObjects ? "Loading objects…" : "e.g. Account or OrderSummary"}
                  disabled={loadingObjects}
                />
                {showObjectOptions && !loadingObjects && (
                  <div className="autocomplete-menu">
                    {filteredObjects.length ? filteredObjects.map((object) => (
                      <button
                        type="button"
                        className="autocomplete-option"
                        key={object}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          setObjectName(object);
                          setObjectSearch(object);
                          setShowObjectOptions(false);
                          setFieldName("");
                          setFieldSearch("");
                          setResult(null);
                          setError("");
                        }}
                      >{object}</button>
                    )) : <div className="autocomplete-empty">No matching objects</div>}
                  </div>
                )}
              </div>
            </div>
            {checkType === "field" && (
              <div className="form-field">
                <label htmlFor="field-name">Field API name</label>
                <div className="autocomplete">
                  <input
                    id="field-name"
                    type="text"
                    value={fieldSearch}
                    autoComplete="off"
                    onFocus={() => setShowFieldOptions(true)}
                    onChange={(event) => {
                      setFieldSearch(event.target.value);
                      setFieldName(event.target.value);
                      setShowFieldOptions(true);
                      setResult(null);
                      setError("");
                    }}
                    onBlur={() => window.setTimeout(() => setShowFieldOptions(false), 150)}
                    placeholder={loadingFields ? "Loading fields…" : "e.g. Account_Code__c"}
                    disabled={loadingFields || !objectName}
                  />
                  {showFieldOptions && !loadingFields && objectName && (
                    <div className="autocomplete-menu">
                      {filteredFields.length ? filteredFields.map((field) => (
                        <button
                          type="button"
                          className="autocomplete-option"
                          key={field}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            setFieldName(field);
                            setFieldSearch(field);
                            setShowFieldOptions(false);
                            setResult(null);
                            setError("");
                          }}
                        >{field}</button>
                      )) : <div className="autocomplete-empty">No matching fields</div>}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}

      </div>
      <div className="form-footer">
        <span>{analysisModeHint(page === "soql" ? "soql" : "access", salesforceConnection)}</span>
        <button className="primary-button" disabled={checking} type="button" onClick={() => { void handleCheck(); }}>
          {checking ? (page === "soql" ? "Analyzing…" : "Checking…") : (page === "soql" ? "Run SOQL Analysis" : "Check Access")}
        </button>
      </div>
      {error && <div className="error-card" role="alert">{error}</div>}
    </section>
  );

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">⬡</div>
        <div className="brand-name"><strong>Salesforce</strong><span>Repository Analyzer</span></div>
        <div className="topbar-right">
          <span className={apiConnected ? "connection online" : "connection offline"}><span className="connection-dot" />{apiConnected ? "API connected" : "API unavailable"}</span>
          <span className={`connection ${repositoryConnectionIndicator(apiConnected, repoChecked, repoReady).connected ? "online" : "offline"}`}
            title={repoReady ? repositoryName : "Salesforce repository setup status"}>
            <span className="connection-dot" />{repositoryConnectionIndicator(apiConnected, repoChecked, repoReady).label}
          </span>
          <span className={`connection ${salesforceConnection === "connected" ? "online" : "offline"}`} title="Salesforce authentication status"><span className="connection-dot" />{salesforceConnectionLabel(salesforceConnection)}</span>
          <span className="avatar">RA</span>
        </div>
      </header>
      <aside className="sidebar">
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="side-links" aria-label="Main navigation">
          <button className={page === "dashboard" ? "active" : ""} onClick={() => navigate("dashboard")}><span className="nav-symbol">▦</span>Dashboard</button>
          <button className={page === "access" ? "active" : ""} onClick={() => navigate("access")}><span className="nav-symbol">◇</span>Access Checker</button>
          <button className={page === "soql" ? "active" : ""} onClick={() => navigate("soql")}><span className="nav-symbol">◎</span>SOQL Security Analysis</button>
          <button className={page === "matrix" ? "active" : ""} onClick={() => navigate("matrix")}><span className="nav-symbol">▤</span>Object Access Matrix</button>
          <button className={page === "stack" ? "active" : ""} onClick={() => navigate("stack")}><span className="nav-symbol">⌁</span>Stack Trace Impact</button>
          <button className={page === "reports" ? "active" : ""} onClick={() => navigate("reports")}><span className="nav-symbol">▧</span>Reports</button>
          <button className={page === "salesforce" ? "active" : ""} onClick={() => navigate("salesforce")}><span className="nav-symbol">☁</span>Salesforce Org</button>
        </nav>
      </aside>
      <main className="main-area">
        <div className="page-heading">
          <div>
            <div className="breadcrumb">WORKSPACE / {page.toUpperCase()}</div>
            <h1>{page === "dashboard" ? "Security overview" : page === "access" ? "Access Checker" : page === "soql" ? "SOQL Security Analysis" : page === "matrix" ? "Object Access Matrix" : page === "stack" ? "Stack Trace Impact Analyzer" : page === "salesforce" ? "Salesforce Org Connectivity" : "Generated reports"}</h1>
            <p>{page === "dashboard" ? "Latest SOQL security findings and quick actions." : page === "access" ? "Object and field permissions by persona." : page === "soql" ? "Persona-specific SOQL findings and Excel output." : page === "matrix" ? "Compare object permissions across personas." : page === "stack" ? "Trace SOQL queries and persona access." : page === "salesforce" ? "Connection status and read-only query tests." : "Excel output from this session."}</p>
          </div>
          {page === "dashboard" && <button className="primary-button" onClick={() => navigate("soql")}>Run SOQL Analysis</button>}
        </div>

        {page === "dashboard" && (
          <>
            <div className="metrics-grid">
              {metricCards.map((metric) => <div className="metric-card" key={metric.label}><div className="metric-label">{metric.label}</div><div className={`metric-icon ${metric.tone}`}>{metric.icon}</div><div className="metric-number">{metric.value ?? "—"}</div></div>)}
            </div>
            <div className="dashboard-grid">
              <section className="panel severity-panel"><h2>Finding severity</h2>{soqlSummary ? <><div className="severity-visual" style={{ background: `conic-gradient(#f04452 0 ${soqlSummary.totalFindings ? 100 * soqlSummary.errors / soqlSummary.totalFindings : 0}%, #f5a23c 0 100%)` }}><div><strong>{soqlSummary.totalFindings}</strong><span>Total findings</span></div></div><div className="legend"><span><i className="dot red-dot"/>Errors <strong>{soqlSummary.errors}</strong></span><span><i className="dot orange-dot"/>Reviews <strong>{soqlSummary.reviews}</strong></span></div></> : <div className="empty-visual"><span>◌</span><p>No analysis completed yet</p><small>Run SOQL Security Analysis to populate this chart.</small></div>}</section>
              <section className="panel summary-panel"><h2>Latest analysis</h2><div className="detail-line"><span>Repository</span><strong title={repositoryName}>{repositoryName || "Not loaded"}</strong></div><div className="detail-line"><span>Last analysed</span><strong>{lastRunAt ? lastRunAt.toLocaleString() : "Not yet run"}</strong></div><div className="detail-line"><span>Persona</span><strong>{lastSoql?.personaName || "—"}</strong></div><div className="detail-line"><span>Reports folder</span><strong title={lastSoql?.outputFolder}>{lastSoql?.outputFolder || "—"}</strong></div></section>
            </div>
            <section className="panel shortcuts-panel"><div className="panel-heading"><div><h2>Quick actions</h2></div></div><div className="quick-actions"><button onClick={() => navigate("access")}><span className="shortcut-icon">◇</span><strong>Check object or field access</strong><small>Resolve permissions for a persona</small><span className="shortcut-arrow">→</span></button><button onClick={() => navigate("soql")}><span className="shortcut-icon">◎</span><strong>Scan SOQL security</strong><small>Generate an Excel workbook</small><span className="shortcut-arrow">→</span></button><button onClick={() => navigate("reports")}><span className="shortcut-icon">▧</span><strong>View report location</strong><small>Find generated Excel reports</small><span className="shortcut-arrow">→</span></button></div></section>
          </>
        )}

        {(page === "access" || page === "soql") && (
          <>
            {analysisForm}
            {result && (
              <section className="results-section">
                {page === "soql" ? (
                  renderSoqlResult(result as SoqlAnalysisResult)
                ) : (
                  <>
                    <div className="results-heading"><div><span>ACCESS RESULT</span><h2>{selectedPersona}</h2></div></div>
                    {checkType === "object" ? renderObjectResult(result as ObjectAccessResult) : renderFieldResult(result as FieldAccessResult)}
                  </>
                )}
              </section>
            )}
          </>
        )}

        {page === "matrix" && <ObjectAccessMatrix objects={objects} loadingObjects={loadingObjects} connection={salesforceConnection} beforeAnalysis={ensureRepositoryReady} />}
        {page === "stack" && <StackTraceImpact connection={salesforceConnection} beforeAnalysis={async () => {
          if (!(await ensureRepositoryReady())) return null;
          return preflightOrgVerification();
        }} />}
        {page === "salesforce" && <SalesforceOrgConnection />}

        {showSoqlOverlay && <AnalysisLoadingOverlay title="Analyzing SOQL" description="Scanning Apex queries and generating the Excel workbook…" />}

        {page === "reports" && <section className="panel reports-panel"><div className="panel-heading"><div><h2>Latest Excel report</h2><p>Saved directly to your configured folder.</p></div></div>{lastSoql ? <><div className="detail-line"><span>Persona</span><strong>{lastSoql.personaName}</strong></div><div className="detail-line"><span>Report folder</span><strong className="path-text">{lastSoql.outputFolder}</strong></div><div className="detail-line"><span>Findings</span><strong>{lastSoql.summary.totalFindings}</strong></div><button className="secondary-button" onClick={() => navigator.clipboard.writeText(lastSoql.outputFolder)}>Copy folder path</button></> : <div className="empty-reports"><span>▧</span><h3>No report yet</h3><p>Run SOQL analysis to generate an Excel workbook.</p><button className="primary-button" onClick={() => navigate("soql")}>Run SOQL Analysis</button></div>}</section>}
      </main>
      {repoModalOpen && (orgGateDismissed || salesforceConnection === "connected") && (
        <RepositorySetupModal
          busy={choosingRepo}
          error={repoError}
          currentPath={repoCurrentPath}
          onChoose={() => { void chooseRepository(); }}
        />
      )}
      {orgStatusChecked && !orgGateDismissed && salesforceConnection !== "connected" && (
        <SalesforceOrgLogin
          firstLaunch
          onConnected={() => { setSalesforceConnection("connected"); setOrgGateDismissed(true); }}
          onContinueRepositoryOnly={() => setOrgGateDismissed(true)}
        />
      )}
      {orgWarning && (
        <OrgAnalysisWarningModal
          warning={orgWarning}
          onCancel={() => dismissOrgWarning(false)}
          onContinue={() => dismissOrgWarning(true)}
        />
      )}
      {reportFolderModalOpen && (
        <ReportOutputSetupModal
          busy={choosingReportFolder}
          explanation={reportFolderExplanation}
          error={reportFolderError}
          onCancel={() => {
            setReportFolderModalOpen(false);
            setReportFolderError("");
          }}
          onChoose={() => { void chooseReportFolderAndRun(); }}
        />
      )}
    </div>
  );
}

export default App;
