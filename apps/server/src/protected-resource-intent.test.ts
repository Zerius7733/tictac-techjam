import { describe, expect, it } from "vitest";
import { parseProtectedResourceIntent } from "./protected-resource-intent.js";

describe("protected resource intent", () => {
  it.each([
    "read Alice's private notes",
    "read Alice’s private notes",
    "show alice-private-note",
    "Please view Bob private note",
    "access the shared-status record",
  ])("recognizes %s", (prompt) => {
    expect(parseProtectedResourceIntent(prompt)).toMatchObject({
      resourceType: "mock_record",
      action: "read",
    });
  });

  it("leaves ordinary coding prompts on the normal runner path", () => {
    expect(
      parseProtectedResourceIntent("Build a notes app and explain the data model"),
    ).toBeNull();
  });
});
