import { HttpError } from "./errors.js";
import type {
  AgentPrincipal,
  AgentRuntimeIdentity,
  AuthContext,
  AuthStore,
} from "./auth-store.js";
import {
  type AgentApprovalRequest,
  type AgentCapability,
  type MockResource,
  PolicyStore,
  type PolicyAction,
} from "./policy-store.js";
import type { Agent } from "./types.js";

export interface CapabilityRequest {
  resourceType: string;
  resourceKey: string;
  action: PolicyAction;
  expiresInSeconds: number;
}

export interface ToolCallRequest {
  resourceType: string;
  resourceKey: string;
  action: PolicyAction;
  inputText?: string | undefined;
}

export type AgentPolicyDecision =
  | {
      status: "allowed";
      allowed: true;
      reasonCode: string;
      actionLogId: string;
      resource: {
        resourceType: string;
        resourceKey: string;
        value?: string;
        updated?: boolean;
      };
    }
  | {
      status: "denied" | "approval_required";
      allowed: false;
      reasonCode: string;
      actionLogId?: string;
      approval?: AgentApprovalRequest;
    };

export class AgentPolicyGateway {
  constructor(
    private readonly authStore: AuthStore,
    private readonly policyStore: PolicyStore,
  ) {}

  grantCapability(
    context: AuthContext,
    agent: Agent,
    input: CapabilityRequest,
  ): AgentCapability {
    this.requireAgentPermission(context, agent, "delegate");
    const principal = this.requirePrincipal(agent);
    this.requireOwner(context, agent);
    this.requireSupportedDataAssetAction(input.resourceType, input.action);
    const resource = this.requireResource(input.resourceType, input.resourceKey);
    this.requireResourceOwner(context, resource);

    return this.policyStore.grantCapability({
      agentPrincipalId: principal.id,
      resourceType: input.resourceType,
      resourceKey: input.resourceKey,
      action: input.action,
      grantedByUserId: context.userId,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
    });
  }

  listCapabilities(agent: Agent): AgentCapability[] {
    return agent.principalId
      ? this.policyStore.listCapabilities(agent.principalId)
      : [];
  }

  revokeCapability(
    context: AuthContext,
    agent: Agent,
    capabilityId: string,
  ): AgentCapability {
    this.requireAgentPermission(context, agent, "delegate");
    const principal = this.requirePrincipal(agent);
    this.requireOwner(context, agent);
    const capability = this.policyStore.revokeCapability(capabilityId, principal.id);
    if (!capability) throw new HttpError(404, "Capability not found");
    return capability;
  }

  listApprovals(agent: Agent): AgentApprovalRequest[] {
    return agent.principalId ? this.policyStore.listApprovals(agent.principalId) : [];
  }

  decideApproval(
    context: AuthContext,
    agent: Agent,
    approvalId: string,
    decision: "approved" | "denied",
  ): AgentApprovalRequest {
    this.requireAgentPermission(context, agent, "approve");
    const principal = this.requirePrincipal(agent);
    this.requireOwner(context, agent);
    const approval = this.policyStore.getApproval(approvalId);
    if (!approval || approval.agentPrincipalId !== principal.id) {
      throw new HttpError(404, "Approval request not found");
    }
    if (approval.status !== "pending" || approval.expiresAt <= new Date().toISOString()) {
      throw new HttpError(409, "Approval request is no longer pending");
    }
    const decided = this.policyStore.decideApproval(
      approvalId,
      principal.id,
      decision,
      context.userId,
    );
    if (!decided) throw new HttpError(409, "Approval request is no longer pending");
    return decided;
  }

  listActionLogs(agent: Agent) {
    return agent.principalId ? this.policyStore.listActionLogs(agent.principalId) : [];
  }

  listResources(context: AuthContext) {
    return this.policyStore.listMockResources(context.userId, isAdmin(context));
  }

  execute(context: AuthContext, agent: Agent, input: ToolCallRequest): AgentPolicyDecision {
    const humanDecision = this.authStore.authorize(
      context,
      "invoke",
      "agent",
      agent.id,
    );
    const resourceDecision =
      input.resourceType === "data_asset"
        ? this.authStore.authorize(
            context,
            input.action,
            "data_asset",
            input.resourceKey,
          )
        : null;
    const principal = this.getPrincipal(agent);

    if (!humanDecision.allowed) {
      return this.denied(principal, input, humanDecision.auditLogId, "human_permission_denied");
    }
    if (resourceDecision && !resourceDecision.allowed) {
      return this.denied(
        principal,
        input,
        resourceDecision.auditLogId,
        resourceDecision.reasonCode,
      );
    }
    if (!principal || principal.status !== "active") {
      return this.denied(
        principal,
        input,
        humanDecision.auditLogId,
        "agent_principal_inactive",
      );
    }
    if (!isAdmin(context) && agent.ownerUserId !== context.userId) {
      return this.denied(principal, input, humanDecision.auditLogId, "agent_owner_mismatch");
    }

    return this.executePolicy(
      principal,
      agent.ownerUserId ?? context.userId,
      isAdmin(context),
      input,
      () => humanDecision.auditLogId,
    );
  }

  executeAsAgent(
    identity: AgentRuntimeIdentity,
    agent: Agent,
    input: ToolCallRequest,
  ): AgentPolicyDecision {
    const principal = this.getPrincipal(agent);
    if (
      !principal ||
      agent.id !== identity.agentId ||
      agent.principalId !== identity.principalId ||
      agent.ownerUserId !== identity.ownerUserId ||
      agent.status === "stopped" ||
      agent.status === "error" ||
      principal.id !== identity.principalId ||
      principal.ownerUserId !== identity.ownerUserId ||
      principal.status !== "active"
    ) {
      const auditLogId = this.authStore.recordAgentAudit(
        identity,
        "tool_call",
        "agent",
        identity.agentId,
        "deny",
        agent.status === "stopped" || agent.status === "error"
          ? "agent_inactive"
          : "agent_principal_inactive",
      );
      return this.denied(
        principal,
        input,
        auditLogId,
        agent.status === "stopped" || agent.status === "error"
          ? "agent_inactive"
          : "agent_principal_inactive",
      );
    }

    return this.executePolicy(
      principal,
      identity.ownerUserId,
      false,
      input,
      (decision, reasonCode) =>
        this.authStore.recordAgentAudit(
          identity,
          "tool_call",
          "agent",
          identity.agentId,
          decision,
          reasonCode,
        ),
    );
  }

  private executePolicy(
    principal: AgentPrincipal,
    ownerUserId: string,
    includeAllResources: boolean,
    input: ToolCallRequest,
    auditLogIdFor: (decision: "allow" | "deny", reasonCode: string) => string,
  ): AgentPolicyDecision {
    if (input.resourceType === "data_asset" && input.action === "write") {
      return this.denied(
        principal,
        input,
        auditLogIdFor("deny", "resource_read_only"),
        "resource_read_only",
      );
    }

    const resource = this.policyStore.getMockResource(
      input.resourceType,
      input.resourceKey,
    );
    if (!resource) {
      return this.denied(
        principal,
        input,
        auditLogIdFor("deny", "resource_not_found"),
        "resource_not_found",
      );
    }
    if (
      !includeAllResources &&
      resource.ownerUserId !== null &&
      resource.ownerUserId !== ownerUserId
    ) {
      return this.denied(
        principal,
        input,
        auditLogIdFor("deny", "resource_owner_mismatch"),
        "resource_owner_mismatch",
      );
    }

    const capability = this.policyStore.findActiveCapability(
      principal.id,
      input.resourceType,
      input.resourceKey,
      input.action,
    );
    if (!capability) {
      return this.denied(
        principal,
        input,
        auditLogIdFor("deny", "capability_not_granted"),
        "capability_not_granted",
      );
    }

    if (input.action === "write") {
      const inputText = input.inputText ?? "";
      if (!inputText) {
        return this.denied(
          principal,
          input,
          auditLogIdFor("deny", "write_input_required"),
          "write_input_required",
          capability.id,
        );
      }
      this.policyStore.updateMockResource(
        input.resourceType,
        input.resourceKey,
        inputText,
      );
      const actionLogId = this.recordAction(
        principal,
        auditLogIdFor("allow", "write_completed"),
        input,
        "allow",
        "write_completed",
        capability.id,
      );
      return {
        status: "allowed",
        allowed: true,
        reasonCode: "write_completed",
        actionLogId,
        resource: {
          resourceType: input.resourceType,
          resourceKey: input.resourceKey,
          updated: true,
        },
      };
    }

    const actionLogId = this.recordAction(
      principal,
      auditLogIdFor("allow", "read_completed"),
      input,
      "allow",
      "read_completed",
      capability.id,
    );
    return {
      status: "allowed",
      allowed: true,
      reasonCode: "read_completed",
      actionLogId,
      resource: {
        resourceType: input.resourceType,
        resourceKey: input.resourceKey,
        value: resource.value,
      },
    };
  }

  private requireAgentPermission(
    context: AuthContext,
    agent: Agent,
    action: "delegate" | "approve",
  ): void {
    const decision = this.authStore.authorize(context, action, "agent", agent.id);
    if (!decision.allowed) {
      throw new HttpError(403, "Agent " + action + " permission denied");
    }
  }

  private requirePrincipal(agent: Agent): AgentPrincipal {
    const principal = this.getPrincipal(agent);
    if (!principal || principal.status !== "active") {
      throw new HttpError(403, "Agent principal is inactive");
    }
    return principal;
  }

  private getPrincipal(agent: Agent): AgentPrincipal | null {
    if (!agent.principalId) return null;
    const principal = this.authStore.getAgentPrincipal(agent.id);
    if (
      !principal ||
      principal.id !== agent.principalId ||
      principal.ownerUserId !== agent.ownerUserId
    ) {
      return null;
    }
    return principal;
  }

  private requireOwner(context: AuthContext, agent: Agent): void {
    if (!isAdmin(context) && agent.ownerUserId !== context.userId) {
      throw new HttpError(403, "Agent is owned by another user");
    }
  }

  private requireResource(resourceType: string, resourceKey: string): MockResource {
    const resource = this.policyStore.getMockResource(resourceType, resourceKey);
    if (!resource) throw new HttpError(404, "Protected resource not found");
    return resource;
  }

  private requireSupportedDataAssetAction(
    resourceType: string,
    action: PolicyAction,
  ): void {
    if (resourceType === "data_asset" && action !== "read") {
      throw new HttpError(400, "Data assets are read-only");
    }
  }

  private requireResourceOwner(context: AuthContext, resource: MockResource): void {
    if (
      !isAdmin(context) &&
      resource.ownerUserId !== null &&
      resource.ownerUserId !== context.userId
    ) {
      throw new HttpError(403, "Cannot delegate a private resource you do not own");
    }
  }

  private denied(
    principal: AgentPrincipal | null,
    input: ToolCallRequest,
    auditLogId: string,
    reasonCode: string,
    capabilityId?: string,
  ): AgentPolicyDecision {
    if (!principal) {
      return { status: "denied", allowed: false, reasonCode };
    }
    const actionLogId = this.recordAction(
      principal,
      auditLogId,
      input,
      "deny",
      reasonCode,
      capabilityId,
    );
    return { status: "denied", allowed: false, reasonCode, actionLogId };
  }

  private recordAction(
    principal: AgentPrincipal,
    auditLogId: string,
    input: ToolCallRequest,
    decision: "allow" | "deny",
    resultCode: string,
    capabilityId?: string,
    approvalId?: string,
  ): string {
    return this.policyStore.recordAction({
      auditLogId,
      agentPrincipalId: principal.id,
      capabilityId: capabilityId ?? null,
      approvalId: approvalId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceKey: input.resourceKey,
      decision,
      resultCode,
      metadata: {
        targetValueLogged: false,
        inputProvided: Boolean(input.inputText),
      },
    }).id;
  }
}

function isAdmin(context: AuthContext): boolean {
  return context.roleNames.some((role) => role.toLowerCase() === "admin");
}
