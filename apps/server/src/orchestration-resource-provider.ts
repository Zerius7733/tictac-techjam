import type { AgentPolicyGateway } from "./agent-policy-gateway.js";
import type { AuthContext, JsonObject } from "./orchestration-contracts.js";
import type { OrchestrationAgentDescriptor } from "./orchestration-dispatcher.js";

export interface ResourceProviderRequest {
  requestId: string;
  jobId: string;
  runId: string;
  agentId: string;
  action: string;
  resourceType: string;
  resourceKey: string;
  purpose: string;
  /** Present when a project run must enforce the target Agent's capability. */
  authContext?: AuthContext;
  agent?: OrchestrationAgentDescriptor;
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
  constructor(private readonly policyGateway?: AgentPolicyGateway) {}

  async provide(request: ResourceProviderRequest): Promise<ResourceProviderResult> {
    const supportedKeys = new Set([
      "order-schema",
      "backend-api-contract",
      "frontend-design-system",
      "shared-project-status",
    ]);
    if (
      request.action !== "read" ||
      request.resourceType !== "data_asset" ||
      !supportedKeys.has(request.resourceKey)
    ) {
      throw new Error("resource_not_allowlisted");
    }

    if (this.policyGateway && request.authContext && request.agent) {
      const decision = this.policyGateway.executeForOrchestration(
        request.authContext,
        request.agent,
        {
          resourceType: request.resourceType,
          resourceKey: request.resourceKey,
          action: "read",
        },
      );
      if (!decision.allowed || !decision.resource?.value) {
        throw new Error("resource_not_available");
      }
      return { content: decision.resource.value };
    }

    const artifacts: Record<string, JsonObject> = {
      "order-schema": {
        name: "order-schema",
        version: "sanitized-v1",
        fields: [
          { name: "id", type: "string", required: true },
          { name: "status", type: "string", required: true },
          { name: "total", type: "number", required: true },
          { name: "createdAt", type: "string", required: true },
        ],
      },
      "backend-api-contract": {
        name: "backend-api-contract",
        version: "v1",
        summary: "Sanitized endpoints and response fields for the order service.",
        endpoints: ["GET /orders/:id", "GET /orders/summary"],
      },
      "frontend-design-system": {
        name: "frontend-design-system",
        version: "v2",
        summary: "Approved tokens and components for the shared dashboard UI.",
        tokens: ["color.surface", "color.accent", "space.4", "radius.card"],
      },
      "shared-project-status": {
        name: "shared-project-status",
        status: "on-track",
        owner: "order-dashboard-team",
      },
    };
    const artifact = artifacts[request.resourceKey];
    if (!artifact) throw new Error("resource_not_available");
    return {
      content: JSON.stringify(artifact),
      payload: artifact,
    };
  }
}
