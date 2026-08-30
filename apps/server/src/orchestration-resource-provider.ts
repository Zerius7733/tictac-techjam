import type { JsonObject } from "./orchestration-contracts.js";

export interface ResourceProviderRequest {
  requestId: string;
  jobId: string;
  runId: string;
  agentId: string;
  action: string;
  resourceType: string;
  resourceKey: string;
  purpose: string;
}

export interface ResourceProviderResult {
  content: string;
  payload?: JsonObject;
}

export interface ResourceProvider {
  provide(request: ResourceProviderRequest): Promise<ResourceProviderResult>;
}

/**
 * Safe local provider used by the POC. It exposes only a static, sanitized
 * artifact and deliberately has no database or filesystem access.
 */
export class AllowlistedResourceProvider implements ResourceProvider {
  async provide(request: ResourceProviderRequest): Promise<ResourceProviderResult> {
    if (
      request.action !== "read" ||
      request.resourceType !== "data_asset" ||
      request.resourceKey !== "order-schema"
    ) {
      throw new Error("resource_not_allowlisted");
    }

    const artifact = {
      name: "order-schema",
      version: "sanitized-v1",
      fields: [
        { name: "id", type: "string", required: true },
        { name: "status", type: "string", required: true },
        { name: "total", type: "number", required: true },
        { name: "createdAt", type: "string", required: true },
      ],
    } satisfies JsonObject;
    return {
      content: JSON.stringify(artifact),
      payload: artifact,
    };
  }
}
