import { useEffect, useMemo, useState } from "react";
import "./App.css";

type Persona = {
  name: string;
};

type ObjectAccessResult = {
  object: string;
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
  type: "permissionSetGroup" | "directPermissionSet";
  permissionSetGroup?: string;
};

type FieldAccessResult = {
  field: string;
  read: boolean;
  edit: boolean;
  readGrantedBy: PermissionSource[];
  editGrantedBy: PermissionSource[];
  mutedBy: string[];
};

type CheckType = "object" | "field";

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
    ObjectAccessResult | FieldAccessResult | null
  >(null);

  const [error, setError] = useState("");

  const [loadingPersonas, setLoadingPersonas] =
    useState(true);

  const [loadingObjects, setLoadingObjects] =
    useState(true);

  const [loadingFields, setLoadingFields] =
    useState(false);

  const [checking, setChecking] =
    useState(false);

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

    loadPersonas();
  }, []);

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

        setObjects(data);
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

    loadObjects();
  }, []);

  useEffect(() => {
  if (!objectName) {
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
}, [objectName]);

  const filteredObjects = useMemo(() => {
    const search =
      objectSearch.trim().toLowerCase();

    if (!search) {
      return objects.slice(0, 20);
    }

    return objects
      .filter((object) =>
        object.toLowerCase().includes(search)
      )
      .slice(0, 20);
  }, [objects, objectSearch]);

  const filteredFields = useMemo(() => {
    const search =
      fieldSearch.trim().toLowerCase();

    if (!search) {
      return fields.slice(0, 20);
    }

    return fields
      .filter((field) =>
        field.toLowerCase().includes(search)
      )
      .slice(0, 20);
  }, [fields, fieldSearch]);

  async function handleCheck() {
    setError("");
    setResult(null);

    if (!selectedPersona) {
      setError("Please select a persona.");
      return;
    }

    if (!objectName.trim()) {
      setError("Please select an object.");
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
      const encodedPersona =
        encodeURIComponent(selectedPersona);

      const encodedObject =
        encodeURIComponent(objectName.trim());

      let url =
        `/api/personas/${encodedPersona}/objects/${encodedObject}`;

      if (checkType === "field") {
        const encodedField =
          encodeURIComponent(fieldName.trim());

        url += `/fields/${encodedField}`;
      }

      const response = await fetch(url);

      if (response.status === 404) {
        setError(
          checkType === "object"
            ? "Object not found."
            : "Field not found."
        );

        return;
      }

      if (!response.ok) {
        throw new Error(
          "Unable to perform the access check."
        );
      }

      const data =
        await response.json();

      setResult(data);
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

  function formatBoolean(value: boolean) {
    return value ? "Yes" : "No";
  }

  function renderObjectResult(
    access: ObjectAccessResult
  ) {
    const permissions = [
      ["Read", access.read],
      ["Create", access.create],
      ["Edit", access.edit],
      ["Delete", access.delete],
      [
        "View All Records",
        access.viewAllRecords,
      ],
      [
        "Modify All Records",
        access.modifyAllRecords,
      ],
      [
        "View All Fields",
        access.viewAllFields,
      ],
    ];

    return (
      <div className="result-card">
        <div className="result-header">
          <span className="result-type">
            OBJECT
          </span>

          <h2>{access.object}</h2>
        </div>

        <div className="permission-grid">
          {permissions.map(
            ([label, value]) => (
              <div
                className="permission-row"
                key={String(label)}
              >
                <span>{label}</span>

                <strong
                  className={
                    value
                      ? "status yes"
                      : "status no"
                  }
                >
                  {formatBoolean(
                    Boolean(value)
                  )}
                </strong>
              </div>
            )
          )}
        </div>
      </div>
    );
  }

  function renderFieldResult(
    access: FieldAccessResult
  ) {
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

            <strong
              className={
                access.read
                  ? "status yes"
                  : "status no"
              }
            >
              {formatBoolean(access.read)}
            </strong>
          </div>

          <div className="permission-row">
            <span>Edit</span>

            <strong
              className={
                access.edit
                  ? "status yes"
                  : "status no"
              }
            >
              {formatBoolean(access.edit)}
            </strong>
          </div>
        </div>

        <div className="source-section">
          <h3>Read granted by</h3>

          {access.readGrantedBy.length === 0 ? (
            <p className="muted">
              No direct grant found.
            </p>
          ) : (
            access.readGrantedBy.map(
              (source, index) => (
                <div
                  className="source-item"
                  key={`read-${index}`}
                >
                  <strong>
                    {source.permissionSet}
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
              No direct grant found.
            </p>
          ) : (
            access.editGrantedBy.map(
              (source, index) => (
                <div
                  className="source-item"
                  key={`edit-${index}`}
                >
                  <strong>
                    {source.permissionSet}
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
          <h3>Muted by</h3>

          {access.mutedBy.length === 0 ? (
            <p className="muted">
              Not muted.
            </p>
          ) : (
            access.mutedBy.map(
              (source) => (
                <div
                  className="source-item muted-source"
                  key={source}
                >
                  {source}
                </div>
              )
            )
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">
            SALESFORCE
          </span>

          <h1>
            Repository Analyzer
          </h1>

          <p>
            Inspect effective object and field
            access by persona.
          </p>
        </div>
      </header>

      <main className="content">
        <section className="query-card">
          <div className="section-title">
            <span>1</span>

            <div>
              <h2>Select Persona</h2>

              <p>
                Choose the business persona you
                want to analyze.
              </p>
            </div>
          </div>

          <select
            value={selectedPersona}
            onChange={(event) => {
              setSelectedPersona(
                event.target.value
              );
              setResult(null);
              setError("");
            }}
            disabled={loadingPersonas}
          >
            <option value="">
              {loadingPersonas
                ? "Loading personas..."
                : "Select a persona"}
            </option>

            {personas.map((persona) => (
              <option
                key={persona.name}
                value={persona.name}
              >
                {persona.name}
              </option>
            ))}
          </select>
        </section>

        <section className="query-card">
          <div className="section-title">
            <span>2</span>

            <div>
              <h2>What do you want to check?</h2>

              <p>
                Choose object-level or
                field-level access.
              </p>
            </div>
          </div>

          <div className="radio-group">
            <label className="radio-option">
              <input
                type="radio"
                checked={
                  checkType === "object"
                }
                onChange={() => {
                  setCheckType("object");
                  setFieldName("");
                  setFieldSearch("");
                  setResult(null);
                  setError("");
                }}
              />

              <span>Object</span>
            </label>

            <label className="radio-option">
              <input
                type="radio"
                checked={
                  checkType === "field"
                }
                onChange={() => {
                  setCheckType("field");
                  setResult(null);
                  setError("");
                }}
              />

              <span>Field</span>
            </label>
          </div>
        </section>

        <section className="query-card">
          <div className="section-title">
            <span>3</span>

            <div>
              <h2>Enter what to check</h2>

              <p>
                Search using Salesforce API names.
              </p>
            </div>
          </div>

          <label className="field-label">
            Object Name

            <div className="autocomplete">
              <input
                type="text"
                value={objectSearch}
                onFocus={() =>
                  setShowObjectOptions(true)
                }
                onChange={(event) => {
                  const value =
                    event.target.value;

                  setObjectSearch(value);
                  setObjectName(value);
                  setShowObjectOptions(true);
                  setResult(null);
                  setError("");

                  if (!value) {
                    setFields([]);
                    setFieldName("");
                    setFieldSearch("");
                  }
                }}
                onBlur={() => {
                  setTimeout(() => {
                    setShowObjectOptions(
                      false
                    );
                  }, 150);
                }}
                placeholder={
                  loadingObjects
                    ? "Loading objects..."
                    : "Search objects..."
                }
                disabled={loadingObjects}
              />

              {showObjectOptions &&
                !loadingObjects && (
                  <div className="autocomplete-menu">
                    {filteredObjects.length > 0 ? (
                      filteredObjects.map(
                        (object) => (
                          <button
                            type="button"
                            className="autocomplete-option"
                            key={object}
                            onMouseDown={(
                              event
                            ) => {
                              event.preventDefault();

                              setObjectName(
                                object
                              );

                              setObjectSearch(
                                object
                              );

                              setShowObjectOptions(
                                false
                              );

                              setFields([]);
                              setFieldName("");
                              setFieldSearch("");
                              setResult(null);
                              setError("");
                            }}
                          >
                            {object}
                          </button>
                        )
                      )
                    ) : (
                      <div className="autocomplete-empty">
                        No matching objects
                      </div>
                    )}
                  </div>
                )}
            </div>
          </label>

          {checkType === "field" && (
            <label className="field-label">
              Field Name

              <div className="autocomplete">
                <input
                  type="text"
                  value={fieldSearch}
                  onFocus={() =>
                    setShowFieldOptions(true)
                  }
                  onChange={(event) => {
                    const value =
                      event.target.value;

                    setFieldSearch(value);
                    setFieldName(value);
                    setShowFieldOptions(true);
                    setResult(null);
                    setError("");
                  }}
                  onBlur={() => {
                    setTimeout(() => {
                      setShowFieldOptions(
                        false
                      );
                    }, 150);
                  }}
                  placeholder={
                    loadingFields
                      ? "Loading fields..."
                      : objectName
                        ? "Search fields..."
                        : "Select an object first"
                  }
                  disabled={
                    loadingFields ||
                    !objectName
                  }
                />

                {showFieldOptions &&
                  !loadingFields &&
                  objectName && (
                    <div className="autocomplete-menu">
                      {filteredFields.length >
                      0 ? (
                        filteredFields.map(
                          (field) => (
                            <button
                              type="button"
                              className="autocomplete-option"
                              key={field}
                              onMouseDown={(
                                event
                              ) => {
                                event.preventDefault();

                                setFieldName(
                                  field
                                );

                                setFieldSearch(
                                  field
                                );

                                setShowFieldOptions(
                                  false
                                );

                                setResult(null);
                                setError("");
                              }}
                            >
                              {field}
                            </button>
                          )
                        )
                      ) : (
                        <div className="autocomplete-empty">
                          No matching fields
                        </div>
                      )}
                    </div>
                  )}
              </div>
            </label>
          )}

          <button
            className="check-button"
            onClick={handleCheck}
            disabled={checking}
          >
            {checking
              ? "Checking..."
              : "Check Access"}
          </button>
        </section>

        {error && (
          <div className="error-card">
            {error}
          </div>
        )}

        {result && (
          <section className="results-section">
            <div className="results-heading">
              <span>RESULT</span>

              <h2>{selectedPersona}</h2>
            </div>

            {checkType === "object"
              ? renderObjectResult(
                  result as ObjectAccessResult
                )
              : renderFieldResult(
                  result as FieldAccessResult
                )}
          </section>
        )}
      </main>
    </div>
  );
}

export default App;