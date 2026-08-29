import type { PolicyAction } from "./policy-store.js";

export type ChatMode = "agent" | "protected-data";

export interface ProtectedResourceIntent {
  resourceType: "mock_record";
  resourceKey: string;
  action: PolicyAction;
  inputText?: string;
}

export interface ProtectedCapabilityGrantIntent {
  kind: "grant-capability";
  resourceType: "mock_record";
  resourceKey: string;
  actions: PolicyAction[];
  expiresInSeconds: number;
}

const resourceAliases: Array<{ resourceKey: string; pattern: RegExp }> = [
  {
    resourceKey: "alice-private-note",
    pattern: /\balice(?:['’]s|s)?[- ]private[- ]notes?\b|\balice-private-note\b/i,
  },
  {
    resourceKey: "bob-private-note",
    pattern: /\bbob(?:['’]s|s)?[- ]private[- ]notes?\b|\bbob-private-note\b/i,
  },
  {
    resourceKey: "shared-status",
    pattern: /\bshared[- ]status\b/i,
  },
];

const readWords =
  /\b(read|show|view|open|access|look\s+at|fetch|get|content(?:s)?|value|text)\b|\bwhat(?:'s| is)\s+(?:in|inside)\b/i;
const writeWords = /\b(write|update|change|replace|edit|set|overwrite|save)\b/i;
const grantWords = /\b(grant|give|allow|delegate|enable)\b/i;
const grantReadWords = /\b(read|view|see)\b/i;

function extractWriteText(prompt: string, resourcePattern: RegExp): string {
  const promptWithoutResource = prompt.replace(resourcePattern, " ");
  const keywordMatch = promptWithoutResource.match(/\b(?:to|with|as)\s+(.+)$/i);
  if (keywordMatch?.[1]) {
    return keywordMatch[1].trim().replace(/^["']|["']$/g, "");
  }

  const colonMatch = promptWithoutResource.match(/:\s*(.+)$/);
  return colonMatch?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
}

/**
 * Translate only the small set of demo resource requests into protected tool
 * calls. Ordinary coding prompts still go to the normal Agent runner.
 */
export function parseProtectedResourceIntent(prompt: string): ProtectedResourceIntent | null {
  const action = writeWords.test(prompt) ? "write" : readWords.test(prompt) ? "read" : null;
  if (!action) return null;
  const resource = resourceAliases.find(({ pattern }) => pattern.test(prompt));
  if (!resource) return null;

  return {
    resourceType: "mock_record",
    resourceKey: resource.resourceKey,
    action,
    ...(action === "write" ? { inputText: extractWriteText(prompt, resource.pattern) } : {}),
  };
}

export function parseProtectedCapabilityGrantIntent(
  prompt: string,
): ProtectedCapabilityGrantIntent | null {
  if (!grantWords.test(prompt)) return null;
  const actions: PolicyAction[] = [];
  if (grantReadWords.test(prompt)) actions.push("read");
  if (writeWords.test(prompt)) actions.push("write");
  if (actions.length === 0) return null;
  const resource = resourceAliases.find(({ pattern }) => pattern.test(prompt));
  if (!resource) return null;

  const hours = prompt.match(/\bfor\s+(\d+)\s*h(?:ours?)?\b/i);
  const minutes = prompt.match(/\bfor\s+(\d+)\s*m(?:in(?:utes?)?)?\b/i);
  const seconds = prompt.match(/\bfor\s+(\d+)\s*s(?:ec(?:onds?)?)?\b/i);
  const duration = hours
    ? Number(hours[1]) * 3_600
    : minutes
      ? Number(minutes[1]) * 60
      : seconds
        ? Number(seconds[1])
        : 3_600;
  if (!Number.isInteger(duration) || duration < 60 || duration > 86_400) return null;

  return {
    kind: "grant-capability",
    resourceType: "mock_record",
    resourceKey: resource.resourceKey,
    actions,
    expiresInSeconds: duration,
  };
}

export function parseAuthenticatorCode(prompt: string): string | null {
  const match = prompt.match(/^\s*(?:auth(?:enticator)?\s*(?:code|token)?\s*[:=]?\s*)?(\d{6})\s*$/i);
  return match?.[1] ?? null;
}
