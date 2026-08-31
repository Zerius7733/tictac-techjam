import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The schema used by collaborative project runs. Keeping this at the runtime
 * boundary means every participating Agent returns a command the dispatcher
 * can route, rather than relying only on prompt instructions.
 */
export const collaborativeOutputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Launchpad collaborative orchestration command",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "content"],
      properties: {
        type: { const: "final" },
        summary: { type: "string", minLength: 1, maxLength: 280 },
        content: {
          anyOf: [
            { type: "string", minLength: 1, maxLength: 50000 },
            { type: "object" },
            { type: "array" },
          ],
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "targetAgentKey", "task"],
      properties: {
        type: { const: "delegate" },
        targetAgentKey: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
        },
        task: { type: "string", minLength: 1, maxLength: 50000 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "type",
        "targetAgentKey",
        "action",
        "resourceType",
        "resourceKey",
        "purpose",
      ],
      properties: {
        type: { const: "resource_request" },
        targetAgentKey: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
        },
        action: { type: "string", minLength: 1, maxLength: 80 },
        resourceType: { type: "string", minLength: 1, maxLength: 80 },
        resourceKey: { type: "string", minLength: 1, maxLength: 160 },
        purpose: { type: "string", minLength: 1, maxLength: 2000 },
      },
    },
  ],
} as const;

/** Write the schema into the app data directory and return its host path. */
export async function writeCollaborativeOutputSchema(
  dataDirectory: string,
): Promise<string> {
  await mkdir(dataDirectory, { recursive: true });
  const schemaPath = path.join(
    dataDirectory,
    "orchestration-output.schema.json",
  );
  await writeFile(schemaPath, JSON.stringify(collaborativeOutputSchema), "utf8");
  return schemaPath;
}
