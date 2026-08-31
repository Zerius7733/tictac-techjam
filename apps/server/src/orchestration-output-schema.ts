import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The schema used by collaborative project runs. Keeping this at the runtime
 * boundary means every participating Agent returns a command the dispatcher
 * can route, rather than relying only on prompt instructions.
 *
 * The Ark structured-output validator accepts one object at the schema root,
 * but rejects a root-level `oneOf`. The command-specific rules therefore stay
 * in `parseAgentCommand`; this runtime schema supplies a provider-compatible
 * envelope and uses nullable fields for properties that do not apply to the
 * selected command type.
 */
export const collaborativeOutputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Launchpad collaborative orchestration command",
  type: "object",
  additionalProperties: false,
  required: [
    "type",
    "summary",
    "content",
    "targetAgentKey",
    "task",
    "action",
    "resourceType",
    "resourceKey",
    "purpose",
  ],
  properties: {
    type: {
      type: "string",
      enum: ["final", "delegate", "resource_request"],
    },
    summary: { type: ["string", "null"] },
    // Structured output schemas do not support unconstrained object/array
    // values reliably across providers. Agents can still put JSON data in
    // this string; non-collaborative runs retain the richer Zod union.
    content: { type: ["string", "null"] },
    targetAgentKey: { type: ["string", "null"] },
    task: { type: ["string", "null"] },
    action: { type: ["string", "null"] },
    resourceType: { type: ["string", "null"] },
    resourceKey: { type: ["string", "null"] },
    purpose: { type: ["string", "null"] },
  },
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
