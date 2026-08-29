import type { PolicyAction } from "./policy-store.js";

export type ChatMode = "agent" | "protected-data";

export interface ProtectedResourceIntent {
  resourceType: "mock_record" | "data_asset";
  resourceKey: string;
  action: PolicyAction;
  inputText?: string;
}

const resourceAliases: Array<{
  resourceType: ProtectedResourceIntent["resourceType"];
  resourceKey: string;
  pattern: RegExp;
}> = [
  {
    resourceType: "mock_record",
    resourceKey: "alice-private-note",
    pattern: /\balice(?:['’]s|s)?[- ]private[- ]notes?\b|\balice-private-note\b/i,
  },
  {
    resourceType: "mock_record",
    resourceKey: "bob-private-note",
    pattern: /\bbob(?:['’]s|s)?[- ]private[- ]notes?\b|\bbob-private-note\b/i,
  },
  {
    resourceType: "mock_record",
    resourceKey: "shared-status",
    pattern: /\bshared[- ]status\b/i,
  },
  {
    resourceType: "data_asset",
    resourceKey: "order-schema",
    pattern: /\border[- ]schema\b|\border[- ]api[- ]contract\b/i,
  },
  {
    resourceType: "data_asset",
    resourceKey: "customer-records",
    pattern: /\bcustomer[- ]records?\b|\bcustomer[- ]data\b/i,
  },
];

const readWords =
  /\b(read|show|view|open|access|look\s+at|fetch|get|content(?:s)?|value|text)\b|\bwhat(?:'s| is)\s+(?:in|inside)\b/i;
const writeWords = /\b(write|update|change|replace|edit|set|overwrite|save)\b/i;

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
    resourceType: resource.resourceType,
    resourceKey: resource.resourceKey,
    action,
    ...(action === "write" ? { inputText: extractWriteText(prompt, resource.pattern) } : {}),
  };
}
