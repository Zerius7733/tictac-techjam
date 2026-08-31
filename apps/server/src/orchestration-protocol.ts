import { z } from "zod";

const boundedText = (max: number) => z.string().trim().min(1).max(max);

const finalContent = z
  .union([
    boundedText(50_000),
    z.record(z.string(), z.unknown()),
    z.array(z.unknown()),
  ])
  .refine(
    (value) =>
      (typeof value === "string" ? value : JSON.stringify(value)).length <=
      50_000,
    "Final response content must be at most 50000 characters",
  );

const agentKey = boundedText(80).regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  "Agent key must contain only letters, numbers, dots, underscores, and hyphens",
);

export const finalAgentCommandSchema = z
  .object({
    type: z.literal("final"),
    summary: boundedText(280).optional(),
    // Agents often return structured contracts here. Keep that structure for
    // the raw JSON view; the dispatcher renders it as readable text for the
    // run result.
    content: finalContent,
  })
  .strict();

export const delegateAgentCommandSchema = z
  .object({
    type: z.literal("delegate"),
    targetAgentKey: agentKey,
    task: boundedText(50_000),
  })
  .strict();

const parallelDelegationSchema = z
  .object({
    targetAgentKey: agentKey,
    task: boundedText(50_000),
  })
  .strict();

export const parallelDelegateAgentCommandSchema = z
  .object({
    type: z.literal("delegate_parallel"),
    delegations: z.array(parallelDelegationSchema).min(2).max(8),
  })
  .strict();

export const resourceRequestCommandSchema = z
  .object({
    type: z.literal("resource_request"),
    targetAgentKey: agentKey,
    action: boundedText(80),
    resourceType: boundedText(80),
    resourceKey: boundedText(160),
    purpose: boundedText(2_000),
  })
  .strict();

export const agentCommandSchema = z.discriminatedUnion("type", [
  finalAgentCommandSchema,
  delegateAgentCommandSchema,
  parallelDelegateAgentCommandSchema,
  resourceRequestCommandSchema,
]);

export type FinalAgentCommand = z.infer<typeof finalAgentCommandSchema>;
export type DelegateAgentCommand = z.infer<typeof delegateAgentCommandSchema>;
export type ParallelDelegateAgentCommand = z.infer<
  typeof parallelDelegateAgentCommandSchema
>;
export type ResourceRequestCommand = z.infer<
  typeof resourceRequestCommandSchema
>;
export type AgentCommand = z.infer<typeof agentCommandSchema>;

export class AgentProtocolError extends Error {
  readonly code = "invalid_agent_protocol";

  constructor(message: string) {
    super(message);
    this.name = "AgentProtocolError";
  }
}

/** Parse only the final Agent message; intermediate prose is never a command. */
export function parseAgentCommand(output: string): AgentCommand {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new AgentProtocolError("Agent output must be valid JSON");
  }

  // Collaborative Runtime schemas use a single provider-compatible object
  // with nullable fields for command variants. Remove only those null
  // placeholders before applying the strict discriminated command schemas;
  // non-null extra fields remain errors instead of being silently ignored.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nullableCommandFields = new Set([
      "summary",
      "content",
      "targetAgentKey",
      "task",
      "action",
      "resourceType",
      "resourceKey",
      "purpose",
      "delegations",
    ]);
    value = Object.fromEntries(
      Object.entries(value).filter(
        ([fieldName, fieldValue]) =>
          fieldValue !== null || !nullableCommandFields.has(fieldName),
      ),
    );
  }

  const parsed = agentCommandSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue?.message ?? "invalid command";
    throw new AgentProtocolError("Invalid Agent command: " + detail);
  }
  return parsed.data;
}

export const agentResumeEnvelopeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("child_result"),
      sourceAgentKey: agentKey,
      content: boundedText(50_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("authorization_denied"),
      action: boundedText(80),
      resourceType: boundedText(80),
      resourceKey: boundedText(160),
      reasonCode: boundedText(160),
    })
    .strict(),
]);

export type AgentResumeEnvelope = z.infer<typeof agentResumeEnvelopeSchema>;
