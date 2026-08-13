import path from "node:path";

import { scanRepository } from "./scanner/repositoryScanner.js";
import { PersonaConfigLoader } from "./config/PersonaConfigLoader.js";
import { PersonaPermissionResolver } from "./analyzer/PersonaPermissionResolver.js";
import { PersonaAccessService } from "./services/PersonaAccessService.js";
import { PersonaFieldAccessService } from "./services/PersonaFieldAccessService.js";
import { AccessQueryService } from "./services/AccessQueryService.js";
import { promptForAccessQuery } from "./cli/accessPrompt.js";
import { scanApexSoql } from "./scanner/apexSoqlScanner.js";
import { SoqlSecurityAnalyzer } from "./analyzer/soqlSecurityAnalyzer.js";
import { writeSoqlReport } from "./reporter/soqlReportWriter.js";

const repositoryPath = process.argv[2];

if (!repositoryPath) {
  console.error(
    "Usage: npm run analyze -- <salesforce-repository-path>"
  );

  process.exit(1);
}

// --------------------------------------------------
// 1. Scan Salesforce repository
// --------------------------------------------------

const paths = await scanRepository(repositoryPath);

console.log("\nSalesforce Repository:");
console.log(paths.repositoryPath);

// --------------------------------------------------
// 2. Load persona configuration
// --------------------------------------------------

const personaConfigLoader =
  new PersonaConfigLoader(
    "./config/personas.json"
  );

const personas =
  await personaConfigLoader.getAllPersonas();

// --------------------------------------------------
// 3. Create permission resolver
// --------------------------------------------------

const personaPermissionResolver =
  new PersonaPermissionResolver(
    paths.permissionSetsPath,
    paths.permissionSetGroupsPath,
    paths.mutingPermissionSetsPath
  );

// --------------------------------------------------
// 4. Create access services
// --------------------------------------------------

const personaAccessService =
  new PersonaAccessService(
    personaPermissionResolver
  );

const personaFieldAccessService =
  new PersonaFieldAccessService(
    personaPermissionResolver
  );

const accessQueryService =
  new AccessQueryService(
    personaAccessService,
    personaFieldAccessService
  );

// --------------------------------------------------
// 5. Create SOQL security analyzer
// --------------------------------------------------

const soqlSecurityAnalyzer =
  new SoqlSecurityAnalyzer(
    personaPermissionResolver,
    path.join(
      paths.defaultPath,
      "objects"
    )
  );

// --------------------------------------------------
// 6. Get user action
// --------------------------------------------------

try {
  const {
    persona,
    action,
    query,
  } = await promptForAccessQuery(
    personas
  );

  console.log("\nSelected Persona:");
  console.log(persona.name);

  // ------------------------------------------------
  // 7. SOQL FLS vulnerability scan
  // ------------------------------------------------

  if (action === "soql") {
    console.log(
      "\nScanning Apex classes for SOQL..."
    );

    const soqlQueries =
      await scanApexSoql(
        repositoryPath
      );

    console.log(
      `SOQL queries analyzed: ${soqlQueries.length}`
    );

    const soqlFindings =
      await soqlSecurityAnalyzer.analyze(
        persona,
        soqlQueries
      );

    const reportPaths =
      await writeSoqlReport(
        "C:\\Users\\703394232\\Desktop\\SalesforceAnalyzerOutputReports",
        persona.name,
        soqlQueries.length,
        soqlFindings
      );

    console.log(
      `SOQL findings: ${soqlFindings.length}`
    );

    console.log(
      `ERROR report: ${reportPaths.errorReportPath}`
    );

    console.log(
      `Other findings report: ${reportPaths.otherReportPath}`
    );

    console.log(
      `Excel summary: ${reportPaths.summaryReportPath}`
    );

    console.log(
      `SOQL findings: ${soqlFindings.length}`
    );

    console.log(
      `ERROR report: ${reportPaths.errorReportPath}`
    );

    console.log(
      `Other findings report: ${reportPaths.otherReportPath}`
    );

    console.log(
      `Summary report: ${reportPaths.summaryReportPath}`
    );

    process.exit(0);
  }

  // ------------------------------------------------
  // 8. Object access check
  // ------------------------------------------------

  if (
    action === "object" &&
    query
  ) {
    const result =
      await accessQueryService.checkObject(
        persona,
        query.objectName
      );

    console.log(
      "\nObject Access:"
    );

    if (!result) {
      console.log(
        "Object not found"
      );

      process.exit(0);
    }

    console.log(
      `Object: ${result.object}`
    );

    // ----------------------------------------------
    // READ
    // ----------------------------------------------

    console.log(
      `Read: ${result.read}`
    );

    console.log(
      "  Granted by:"
    );

    if (
      result.readGrantedBy.length ===
      0
    ) {
      console.log(
        "    None"
      );
    } else {
      for (
        const source of
          result.readGrantedBy
      ) {
        if (
          source.type ===
          "permissionSetGroup"
        ) {
          console.log(
            `    PSG: ${source.permissionSetGroup}`
          );
        }

        console.log(
          `    Permission Set: ${source.permissionSet}`
        );
      }
    }

    if (
      result.readMutedBy.length >
      0
    ) {
      console.log(
        "  Muted by:"
      );

      for (
        const source of
          result.readMutedBy
      ) {
        console.log(
          `    ${source}`
        );
      }
    }

    // ----------------------------------------------
    // CREATE
    // ----------------------------------------------

    console.log(
      `Create: ${result.create}`
    );

    console.log(
      "  Granted by:"
    );

    if (
      result.createGrantedBy.length ===
      0
    ) {
      console.log(
        "    None"
      );
    } else {
      for (
        const source of
          result.createGrantedBy
      ) {
        if (
          source.type ===
          "permissionSetGroup"
        ) {
          console.log(
            `    PSG: ${source.permissionSetGroup}`
          );
        }

        console.log(
          `    Permission Set: ${source.permissionSet}`
        );
      }
    }

    if (
      result.createMutedBy.length >
      0
    ) {
      console.log(
        "  Muted by:"
      );

      for (
        const source of
          result.createMutedBy
      ) {
        console.log(
          `    ${source}`
        );
      }
    }

    // ----------------------------------------------
    // EDIT
    // ----------------------------------------------

    console.log(
      `Edit: ${result.edit}`
    );

    console.log(
      "  Granted by:"
    );

    if (
      result.editGrantedBy.length ===
      0
    ) {
      console.log(
        "    None"
      );
    } else {
      for (
        const source of
          result.editGrantedBy
      ) {
        if (
          source.type ===
          "permissionSetGroup"
        ) {
          console.log(
            `    PSG: ${source.permissionSetGroup}`
          );
        }

        console.log(
          `    Permission Set: ${source.permissionSet}`
        );
      }
    }

    if (
      result.editMutedBy.length >
      0
    ) {
      console.log(
        "  Muted by:"
      );

      for (
        const source of
          result.editMutedBy
      ) {
        console.log(
          `    ${source}`
        );
      }
    }

    // ----------------------------------------------
    // DELETE
    // ----------------------------------------------

    console.log(
      `Delete: ${result.delete}`
    );

    console.log(
      "  Granted by:"
    );

    if (
      result.deleteGrantedBy.length ===
      0
    ) {
      console.log(
        "    None"
      );
    } else {
      for (
        const source of
          result.deleteGrantedBy
      ) {
        if (
          source.type ===
          "permissionSetGroup"
        ) {
          console.log(
            `    PSG: ${source.permissionSetGroup}`
          );
        }

        console.log(
          `    Permission Set: ${source.permissionSet}`
        );
      }
    }

    if (
      result.deleteMutedBy.length >
      0
    ) {
      console.log(
        "  Muted by:"
      );

      for (
        const source of
          result.deleteMutedBy
      ) {
        console.log(
          `    ${source}`
        );
      }
    }

    // ----------------------------------------------
    // OTHER OBJECT PERMISSIONS
    // ----------------------------------------------

    console.log(
      `View All Records: ${result.viewAllRecords}`
    );

    console.log(
      `Modify All Records: ${result.modifyAllRecords}`
    );

    console.log(
      `View All Fields: ${result.viewAllFields}`
    );

    process.exit(0);
  }

  // ------------------------------------------------
  // 9. Field access check
  // ------------------------------------------------

  if (
    action === "field" &&
    query
  ) {
    const result =
      await accessQueryService.checkField(
        persona,
        query.objectName,
        query.fieldName!
      );

    console.log(
      "\nField Access:"
    );

    if (!result) {
      console.log(
        "Field not found"
      );

      process.exit(0);
    }

    console.log(
      `Field: ${result.field}`
    );

    // ----------------------------------------------
    // READ
    // ----------------------------------------------

    console.log(
      `Read: ${result.read}`
    );

    console.log(
      "  Granted by:"
    );

    if (
      result.readGrantedBy.length ===
      0
    ) {
      console.log(
        "    None"
      );
    } else {
      for (
        const source of
          result.readGrantedBy
      ) {
        if (
          source.type ===
          "permissionSetGroup"
        ) {
          console.log(
            `    PSG: ${source.permissionSetGroup}`
          );
        }

        console.log(
          `    Permission Set: ${source.permissionSet}`
        );
      }
    }

    if (
      result.mutedBy.length >
      0
    ) {
      console.log(
        "  Muted by:"
      );

      for (
        const source of
          result.mutedBy
      ) {
        console.log(
          `    ${source}`
        );
      }
    }

    // ----------------------------------------------
    // EDIT
    // ----------------------------------------------

    console.log(
      `Edit: ${result.edit}`
    );

    console.log(
      "  Granted by:"
    );

    if (
      result.editGrantedBy.length ===
      0
    ) {
      console.log(
        "    None"
      );
    } else {
      for (
        const source of
          result.editGrantedBy
      ) {
        if (
          source.type ===
          "permissionSetGroup"
        ) {
          console.log(
            `    PSG: ${source.permissionSetGroup}`
          );
        }

        console.log(
          `    Permission Set: ${source.permissionSet}`
        );
      }
    }

    process.exit(0);
  }

  throw new Error(
    "No valid action was selected."
  );
} catch (error) {
  console.error(
    `\nError: ${
      error instanceof Error
        ? error.message
        : String(error)
    }`
  );

  process.exit(1);
}