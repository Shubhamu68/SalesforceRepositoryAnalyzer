export type SoqlSecurityMode =
  | "USER_MODE"
  | "NO_USER_MODE";

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
}