import readline from "node:readline/promises";
import {
  stdin as input,
  stdout as output,
} from "node:process";

import { Persona } from "../models/Persona.js";

export type AccessQueryType =
  | "object"
  | "field";

export type ActionType =
  | "object"
  | "field"
  | "soql";

export interface AccessQuery {
  type: AccessQueryType;
  objectName: string;
  fieldName?: string;
}

export async function promptForAccessQuery(
  personas: Persona[]
): Promise<{
  persona: Persona;
  action: ActionType;
  query?: AccessQuery;
}> {
  const rl = readline.createInterface({
    input,
    output,
  });

  try {
    console.log("\nAvailable Personas:");

    personas.forEach((persona, index) => {
      console.log(
        `${index + 1}. ${persona.name}`
      );
    });

    const personaInput =
      await rl.question(
        "\nSelect Persona (enter number): "
      );

    const personaIndex =
      Number(personaInput) - 1;

    if (
      personaIndex < 0 ||
      personaIndex >= personas.length ||
      !Number.isInteger(personaIndex)
    ) {
      throw new Error(
        "Invalid persona selection."
      );
    }

    const persona =
      personas[personaIndex];

    console.log(
      "\nWhat do you want to check?"
    );

    console.log("1. Object Access");
    console.log("2. Field Access");
    console.log(
      "3. Check SOQL FLS Vulnerability"
    );

    const actionInput =
      await rl.question(
        "\nSelect option (1, 2 or 3): "
      );

    if (actionInput === "3") {
      return {
        persona,
        action: "soql",
      };
    }

    if (actionInput === "1") {
      const objectName = (
        await rl.question(
          "\nEnter Object Name: "
        )
      ).trim();

      if (!objectName) {
        throw new Error(
          "Object name cannot be empty."
        );
      }

      return {
        persona,
        action: "object",
        query: {
          type: "object",
          objectName,
        },
      };
    }

    if (actionInput === "2") {
      const objectName = (
        await rl.question(
          "\nEnter Object Name: "
        )
      ).trim();

      if (!objectName) {
        throw new Error(
          "Object name cannot be empty."
        );
      }

      const fieldName = (
        await rl.question(
          "\nEnter Field Name: "
        )
      ).trim();

      if (!fieldName) {
        throw new Error(
          "Field name cannot be empty."
        );
      }

      return {
        persona,
        action: "field",
        query: {
          type: "field",
          objectName,
          fieldName,
        },
      };
    }

    throw new Error(
      "Invalid option. Please select 1, 2 or 3."
    );
  } finally {
    rl.close();
  }
}