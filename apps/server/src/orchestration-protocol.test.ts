import { describe, expect, it } from "vitest";
import {
  AgentProtocolError,
  agentResumeEnvelopeSchema,
  parseAgentCommand,
} from "./orchestration-protocol.js";

describe("structured Agent orchestration protocol", () => {
  it("parses a final response", () => {
    expect(
      parseAgentCommand(
        '{"type":"final","summary":"Completed the requested task.","content":"Done."}',
      ),
    ).toEqual({
      type: "final",
      summary: "Completed the requested task.",
      content: "Done.",
    });
  });

  it("parses delegation and resource requests", () => {
    expect(
      parseAgentCommand(
        '{"type":"delegate","targetAgentKey":"bob-order-service","task":"Provide the approved schema."}',
      ),
    ).toMatchObject({ type: "delegate", targetAgentKey: "bob-order-service" });
    expect(
      parseAgentCommand(
        '{"type":"resource_request","targetAgentKey":"bob-order-service","action":"read","resourceType":"data_asset","resourceKey":"order-schema","purpose":"Build the dashboard"}',
      ),
    ).toMatchObject({ type: "resource_request", resourceKey: "order-schema" });
  });

  it("rejects prose, malformed JSON, unknown commands, and identity fields", () => {
    for (const output of [
      "Please ask Bob for the schema.",
      "{not-json}",
      '{"type":"delegate","targetAgentKey":"bob","task":"x","allowed":true}',
      '{"type":"final","content":"x","userId":"admin"}',
    ]) {
      expect(() => parseAgentCommand(output)).toThrow(AgentProtocolError);
    }
  });

  it("validates resume envelopes", () => {
    expect(
      agentResumeEnvelopeSchema.parse({
        type: "authorization_denied",
        action: "read",
        resourceType: "data_asset",
        resourceKey: "customer-records",
        reasonCode: "permission_missing",
      }),
    ).toEqual({
      type: "authorization_denied",
      action: "read",
      resourceType: "data_asset",
      resourceKey: "customer-records",
      reasonCode: "permission_missing",
    });
  });
});
