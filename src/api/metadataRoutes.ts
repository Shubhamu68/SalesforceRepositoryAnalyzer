import { Router } from "express";
import { readdir } from "node:fs/promises";
import path from "node:path";

export function createMetadataRouter(
  defaultPath: string
) {
  const router = Router();

  // --------------------------------------------------
  // Objects
  // --------------------------------------------------

  router.get("/objects", async (_req, res) => {
    try {
      const objectsPath = path.join(
        defaultPath,
        "objects"
      );

      const objects = await readdir(
        objectsPath,
        { withFileTypes: true }
      );

      const names = objects
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) =>
          a.localeCompare(b)
        );

      res.json(names);
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  });

  // --------------------------------------------------
  // Fields for object
  // --------------------------------------------------

  router.get(
    "/objects/:objectName/fields",
    async (req, res) => {
      try {
        const objectName =
          req.params.objectName;

        const fieldsPath = path.join(
          defaultPath,
          "objects",
          objectName,
          "fields"
        );

        const fieldFiles = await readdir(
          fieldsPath,
          { withFileTypes: true }
        );

        const fields = fieldFiles
          .filter(
            (entry) =>
              entry.isFile() &&
              entry.name.endsWith(
                ".field-meta.xml"
              )
          )
          .map((entry) =>
            entry.name.replace(
              ".field-meta.xml",
              ""
            )
          )
          .sort((a, b) =>
            a.localeCompare(b)
          );

        res.json(fields);
      } catch (error) {
        res.status(500).json({
          error:
            error instanceof Error
              ? error.message
              : String(error),
        });
      }
    }
  );

  return router;
}