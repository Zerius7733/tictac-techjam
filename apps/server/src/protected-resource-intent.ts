import type { PolicyAction } from "./policy-store.js";

export interface ProtectedResourceIntent {
  resourceType: "mock_record";
  resourceKey: string;
  action: PolicyAction;
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

const readWords = /\b(read|show|view|open|access|look\s+at|fetch|get)\b/i;

/**
 * Translate only the small set of demo resource requests into protected tool
 * calls. Ordinary coding prompts still go to the normal Agent runner.
 */
export function parseProtectedResourceIntent(prompt: string): ProtectedResourceIntent | null {
  if (!readWords.test(prompt)) return null;
  const resource = resourceAliases.find(({ pattern }) => pattern.test(prompt));
  return resource
    ? { resourceType: "mock_record", resourceKey: resource.resourceKey, action: "read" }
    : null;
}
