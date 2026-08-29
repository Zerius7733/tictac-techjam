import { randomUUID } from "node:crypto";
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
  approvalGroupId?: string;
}

export interface ToolCallRequest {
  resourceType: string;
  resourceKey: string;
  action: PolicyAction;
  inputText?: string | undefined;
}

export const CAPABILITY_APPROVAL_PREFIX = "capability:";

function capabilityApprovalInput(
  action: PolicyAction,
  expiresInSeconds: number,
  approvalGroupId: string = randomUUID(),
): string {
  return `${CAPABILITY_APPROVAL_PREFIX}${approvalGroupId}:${action}:${expiresInSeconds}`;
}

export interface CapabilityApprovalResult {
  approved: boolean;
  reasonCode: "authenticator_verified" | "authenticator_invalid";
  approval: AgentApprovalRequest;
  capability?: AgentCapability;
  expiresInSeconds: number;
}

export interface CapabilityApprovalBatchResult {
  approved: boolean;
  reasonCode: "authenticator_verified" | "authenticator_invalid";
  approvals: AgentApprovalRequest[];
  capabilities: AgentCapability[];
  expiresInSeconds: number;
}

export type WriteCapabilityApprovalResult = CapabilityApprovalResult;

function parseCapabilityApprovalInput(
  inputText: string,
): { action: PolicyAction; expiresInSeconds: number; approvalGroupId: string | null } | null {
  const groupedMatch = inputText.match(/^capability:([0-9a-f-]+):(read|write):(\d+)$/i);
  const match = groupedMatch ?? inputText.match(/^capability:(read|write):(\d+)$/i);
  if (!match) return null;
  const expiresInSeconds = Number(groupedMatch ? match[3] : match[2]);
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 86_400) {
    return null;
  }
  const action = groupedMatch ? match[2] : match[1];
  if (action !== "read" && action !== "write") return null;
  return {
    action,
    expiresInSeconds,
    approvalGroupId: groupedMatch ? match[1] ?? null : null,
  };
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
    void context;
    void agent;
    void input;
    throw new HttpError(
      409,
      "Read and write capabilities require authenticator verification in Protected data chat",
    );
  }

  requestCapability(
    context: AuthContext,
    agent: Agent,
    input: CapabilityRequest,
  ): AgentApprovalRequest {
    if (
      !Number.isInteger(input.expiresInSeconds) ||
      input.expiresInSeconds < 60 ||
      input.expiresInSeconds > 86_400
    ) {
      throw new HttpError(400, "Capability duration must be between 1 minute and 24 hours");
    }
    this.requireAgentPermission(context, agent, "delegate");
    const principal = this.requirePrincipal(agent);
    this.requireOwner(context, agent);
    const resource = this.requireResource(input.resourceType, input.resourceKey);
    this.requireResourceOwner(context, resource);
    const approvalInput = capabilityApprovalInput(
      input.action,
      input.expiresInSeconds,
      input.approvalGroupId,
    );

    const existing = this.policyStore.findPendingApproval(
      principal.id,
      input.action,
      input.resourceType,
      input.resourceKey,
      approvalInput,
      context.userId,
    );
    if (existing) return existing;

    return this.policyStore.createApproval({
      agentPrincipalId: principal.id,
      requestedByUserId: context.userId,
      action: input.action,
      resourceType: input.resourceType,
      resourceKey: input.resourceKey,
      inputText: approvalInput,
      // The approval request is short-lived. The granted capability, after
      // verification, gets the requested lifetime.
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
  }

  requestWriteCapability(
    context: AuthContext,
    agent: Agent,
    input: Omit<CapabilityRequest, "action">,
  ): AgentApprovalRequest {
    return this.requestCapability(context, agent, { ...input, action: "write" });
  }

  verifyCapability(
    context: AuthContext,
    agent: Agent,
    approvalId: string,
    code: string,
  ): CapabilityApprovalResult {
    const result = this.verifyCapabilities(context, agent, [approvalId], code);
    return {
      approved: result.approved,
      reasonCode: result.reasonCode,
      approval: result.approvals[0]!,
      ...(result.capabilities[0] ? { capability: result.capabilities[0] } : {}),
      expiresInSeconds: result.expiresInSeconds,
    };
  }

  verifyCapabilities(
    context: AuthContext,
    agent: Agent,
    approvalIds: string[],
    code: string,
  ): CapabilityApprovalBatchResult {
    this.requireAgentPermission(context, agent, "delegate");
    const principal = this.requirePrincipal(agent);
    this.requireOwner(context, agent);
    const approvals = approvalIds.map((id) => this.policyStore.getApproval(id));
    const requests = approvals.map((approval) =>
      approval ? parseCapabilityApprovalInput(approval.inputText) : null,
    );
    const firstRequest = requests[0];
    if (
      approvalIds.length === 0 ||
      new Set(approvalIds).size !== approvalIds.length ||
      approvals.some((approval, index) =>
        !approval ||
        approval.agentPrincipalId !== principal.id ||
        approval.requestedByUserId !== context.userId ||
        approval.action !== requests[index]?.action,
      ) ||
      requests.some((request) =>
        !request ||
        request.approvalGroupId !== firstRequest?.approvalGroupId ||
        request.expiresInSeconds !== firstRequest?.expiresInSeconds,
      )
    ) {
      throw new HttpError(404, "Capability authorization request not found");
    }
    const validApprovals = approvals as AgentApprovalRequest[];
    if (validApprovals.some((approval) =>
      approval.status !== "pending" || approval.expiresAt <= new Date().toISOString(),
    )) {
      throw new HttpError(409, "Capability authorization request is no longer pending");
    }

    const verified = this.authStore.verifyAuthenticatorCode(
      context.userId,
      code,
      context.requestId,
    );
    if (!verified) {
      const denied = validApprovals.map((approval) => {
        const result = this.policyStore.decideApproval(
          approval.id,
          principal.id,
          "denied",
          context.userId,
        );
        if (!result) throw new HttpError(409, "Capability authorization request is no longer pending");
        return result;
      });
      return {
        approved: false,
        reasonCode: "authenticator_invalid",
        approvals: denied,
        capabilities: [],
        expiresInSeconds: firstRequest!.expiresInSeconds,
      };
    }

    const capabilities = validApprovals.map((approval, index) =>
      this.policyStore.grantCapability({
        agentPrincipalId: principal.id,
        resourceType: approval.resourceType,
        resourceKey: approval.resourceKey,
        action: requests[index]!.action,
        grantedByUserId: context.userId,
        expiresAt: new Date(
          Date.now() + firstRequest!.expiresInSeconds * 1000,
        ).toISOString(),
      }),
    );
    const approved = validApprovals.map((approval) => {
      const result = this.policyStore.decideApproval(
        approval.id,
        principal.id,
        "approved",
        context.userId,
      );
      if (!result) throw new HttpError(409, "Capability authorization request is no longer pending");
      return result;
    });
    return {
      approved: true,
      reasonCode: "authenticator_verified",
      approvals: approved,
      capabilities,
      expiresInSeconds: firstRequest!.expiresInSeconds,
    };
  }

  verifyWriteCapability(
    context: AuthContext,
    agent: Agent,
    approvalId: string,
    code: string,
  ): WriteCapabilityApprovalResult {
    return this.verifyCapability(context, agent, approvalId, code);
  }

  listPendingCapabilityApprovals(
    agent: Agent,
    requestedByUserId: string,
  ): AgentApprovalRequest[] {
    const pending = this.listApprovals(agent).filter(
      (approval) =>
        approval.status === "pending" &&
        approval.requestedByUserId === requestedByUserId &&
        approval.expiresAt > new Date().toISOString() &&
        parseCapabilityApprovalInput(approval.inputText) !== null,
    );
    const latest = pending[0];
    const latestRequest = latest ? parseCapabilityApprovalInput(latest.inputText) : null;
    if (!latest || !latestRequest) return [];
    return pending.filter((approval) => {
      const request = parseCapabilityApprovalInput(approval.inputText);
      return (
        request?.approvalGroupId === latestRequest.approvalGroupId &&
        request.expiresInSeconds === latestRequest.expiresInSeconds &&
        approval.resourceType === latest.resourceType &&
        approval.resourceKey === latest.resourceKey
      );
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
    if (
      parseCapabilityApprovalInput(approval.inputText)
    ) {
      throw new HttpError(
        409,
        "Read and write approvals require the six-digit authenticator code in Protected data chat",
      );
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
    const principal = this.getPrincipal(agent);

    if (!humanDecision.allowed) {
      return this.denied(principal, input, humanDecision.auditLogId, "human_permission_denied");
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

    const authenticatorApproval = this.policyStore.findApprovedApproval(
      principal.id,
      input.action,
      input.resourceType,
      input.resourceKey,
      CAPABILITY_APPROVAL_PREFIX,
    );
    if (!authenticatorApproval) {
      return this.denied(
        principal,
        input,
        auditLogIdFor("deny", "authenticator_not_verified"),
        "authenticator_not_verified",
        capability.id,
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
        authenticatorApproval.id,
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
      authenticatorApproval.id,
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
    if (!resource) throw new HttpError(404, "Mock resource not found");
    return resource;
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
