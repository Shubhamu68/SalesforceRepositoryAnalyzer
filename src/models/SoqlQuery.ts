import type { DeclaredSoqlMode } from "../analyzer/soqlExecutionMode.js";

export type SoqlSecurityMode = DeclaredSoqlMode;

export interface SoqlSubquery {
  /*
   * This is the value after FROM inside
   * a nested SOQL query.
   *
   * Example:
   *
   * (
   *   SELECT Id, LastName
   *   FROM Contacts
   * )
   *
   * relationshipName = "Contacts"
   *
   * It is resolved using:
   *
   * Parent Object
   *   +
   * relationshipName
   *   ->
   * Child Object
   */
  relationshipName: string;
  /** CHILD resolves through parent childRelationships; semi-/anti-joins use an object API name. */
  kind?: "CHILD" | "SEMI_JOIN" | "ANTI_JOIN";
  /** Source of this nested SELECT, retained for its own WHERE/ORDER BY analysis. */
  query?: string;
  /** Precise Apex line on which the nested SELECT starts. */
  lineNumber?: number;

  fields: string[];

  subqueries: SoqlSubquery[];
}

export interface SoqlQuery {
  filePath: string;
  lineNumber: number;
  query: string;

  /*
   * Root object of the SOQL query.
   */
  object: string;

  /*
   * Fields directly selected from the
   * root object.
   */
  fields: string[];

  /*
   * Child relationship subqueries.
   *
   * Supports multiple nesting levels.
   */
  subqueries: SoqlSubquery[];

  withUserMode: boolean;

  securityMode: SoqlSecurityMode;
  /** Explicit AccessLevel on a dynamic Database method; overrides API default. */
  dynamicAccessLevel?: "USER_MODE" | "SYSTEM_MODE";
  /** Stable execution-site and variant IDs; not exposed as new Excel columns. */
  dynamicOrigin?: boolean;
  /** Incomplete coverage: explicit caller sample or a typed numeric-slot structure. */
  coverage?: "KNOWN_CALLER_CONTEXT" | "PROVEN_PARTIAL_STRUCTURE";
  querySiteId?: string;
  queryVariantId?: string;
}