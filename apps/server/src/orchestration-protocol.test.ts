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

  it("accepts structured final content for contract responses", () => {
    expect(
      parseAgentCommand(
        '{"type":"final","summary":"Returned the approved contract.","content":{"orders":{"order_id":"string","total_amount":"decimal"}}}',
      ),
    ).toEqual({
      type: "final",
      summary: "Returned the approved contract.",
      content: {
        orders: {
          order_id: "string",
          total_amount: "decimal",
        },
      },
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
        '{"type":"resource_request","targetAgentKey":"bob-order-service","action":"read","resourceType":"data_asset","resourceKey":"database","purpose":"Build the dashboard","query":"orders.list?status=pending&limit=10"}',
      ),
    ).toMatchObject({
      type: "resource_request",
      resourceKey: "database",
      query: "orders.list?status=pending&limit=10",
    });
  });

  it("accepts nullable placeholders emitted by the collaborative Runtime schema", () => {
    expect(
      parseAgentCommand(
        '{"type":"delegate","summary":null,"content":null,"targetAgentKey":"bob-order-service","task":"Provide the approved schema.","action":null,"resourceType":null,"resourceKey":null,"purpose":null}',
      ),
    ).toEqual({
      type: "delegate",
      targetAgentKey: "bob-order-service",
      task: "Provide the approved schema.",
    });
  });

  it("rejects prose, malformed JSON, unknown commands, and identity fields", () => {
    for (const output of [
      "Please ask Bob for the schema.",
      "{not-json}",
      '{"type":"delegate","targetAgentKey":"bob","task":"x","allowed":true}',
      '{"type":"final","content":"x","userId":"admin"}',
      '{"type":"final","content":"x","userId":null}',
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
