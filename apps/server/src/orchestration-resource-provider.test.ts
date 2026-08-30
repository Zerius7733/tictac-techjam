import { describe, expect, it } from "vitest";
import { AllowlistedResourceProvider } from "./orchestration-resource-provider.js";

describe("AllowlistedResourceProvider", () => {
  it("returns only the sanitized order schema artifact", async () => {
    const provider = new AllowlistedResourceProvider();
    const result = await provider.provide({
      requestId: "request-provider",
      jobId: "job-provider",
      runId: "run-provider",
      agentId: "agent-alice",
      action: "read",
      resourceType: "data_asset",
      resourceKey: "order-schema",
      purpose: "Build the dashboard",
    });
    expect(JSON.parse(result.content)).toEqual({
      name: "order-schema",
      version: "sanitized-v1",
      fields: [
        { name: "id", type: "string", required: true },
        { name: "status", type: "string", required: true },
        { name: "total", type: "number", required: true },
        { name: "createdAt", type: "string", required: true },
      ],
    });
    expect(result.content).not.toMatch(/token|password|secret/i);
  });

  it("fails closed for resources outside the allowlist", async () => {
    const provider = new AllowlistedResourceProvider();
    await expect(
      provider.provide({
        requestId: "request-provider",
        jobId: "job-provider",
        runId: "run-provider",
        agentId: "agent-alice",
        action: "read",
        resourceType: "data_asset",
        resourceKey: "customer-records",
        purpose: "Build the dashboard",
      }),
    ).rejects.toThrow("resource_not_allowlisted");
  });
});
