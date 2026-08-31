import { describe, expect, it } from "vitest";
import { collaborativeOutputSchema } from "./orchestration-output-schema.js";

describe("collaborative Runtime output schema", () => {
  it("uses one provider-compatible object at the root", () => {
    expect(collaborativeOutputSchema.type).toBe("object");
    expect(collaborativeOutputSchema).not.toHaveProperty("oneOf");
    expect(collaborativeOutputSchema).not.toHaveProperty("anyOf");
    expect(collaborativeOutputSchema.additionalProperties).toBe(false);
  });

  it("requires every field and makes command-specific fields nullable", () => {
    const required = collaborativeOutputSchema.required;
    const properties = collaborativeOutputSchema.properties;

    expect(required).toEqual([
      "type",
      "summary",
      "content",
      "targetAgentKey",
      "task",
      "action",
      "resourceType",
      "resourceKey",
      "purpose",
      "query",
      "delegations",
    ]);
    expect(properties.type).toEqual({
      type: "string",
      enum: ["final", "delegate", "delegate_parallel", "resource_request"],
    });
    for (const field of required.slice(1, -1)) {
      expect(properties[field]).toEqual({ type: ["string", "null"] });
    }
    expect(properties.delegations).toMatchObject({
      type: ["array", "null"],
      minItems: 2,
      maxItems: 8,
    });
  });
});
