import type { PolicyAction } from "./policy-store.js";

export type ChatMode = "agent" | "protected-data";

export interface ProtectedResourceIntent {
  resourceType: "mock_record";
  resourceKey: string;
  action: PolicyAction;
  inputText?: string;
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
const capabilityGrantWords = /\b(grant|give|allow|delegate|enable)\b/i;

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
  if (capabilityGrantWords.test(prompt)) return null;
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

export function isProtectedCapabilityGrantRequest(prompt: string): boolean {
  return capabilityGrantWords.test(prompt);
}
