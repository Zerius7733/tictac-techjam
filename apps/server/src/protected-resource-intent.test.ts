import { describe, expect, it } from "vitest";
import {
  isProtectedCapabilityGrantRequest,
  parseProtectedResourceIntent,
} from "./protected-resource-intent.js";

describe("protected resource intent", () => {
  it.each([
    "read Alice's private notes",
    "read Alice’s private notes",
    "show alice-private-note",
    "Please view Bob private note",
    "access the shared-status record",
    "tell me the contents of Alice's private notes",
    "what's in Alice's private note",
  ])("recognizes %s", (prompt) => {
    expect(parseProtectedResourceIntent(prompt)).toMatchObject({
      resourceType: "mock_record",
      action: "read",
    });
  });

  it("extracts the proposed value from a protected write request", () => {
    expect(
      parseProtectedResourceIntent(
        "write into Alice's private notes, changing it to Sahara means desert",
      ),
    ).toEqual({
      resourceType: "mock_record",
      resourceKey: "alice-private-note",
      action: "write",
      inputText: "Sahara means desert",
    });
  });

  it("recognizes a write without inventing a value", () => {
    expect(parseProtectedResourceIntent("write to alice-private-note")).toEqual({
      resourceType: "mock_record",
      resourceKey: "alice-private-note",
      action: "write",
      inputText: "",
    });
  });

  it("leaves ordinary coding prompts on the normal runner path", () => {
    expect(
      parseProtectedResourceIntent("Build a notes app and explain the data model"),
    ).toBeNull();
  });

  it("does not treat chat as a capability-grant surface", () => {
    const prompt = "grant read and write access to Alice's private notes for 1 hour";
    expect(isProtectedCapabilityGrantRequest(prompt)).toBe(true);
    expect(parseProtectedResourceIntent(prompt)).toBeNull();
    expect(parseProtectedResourceIntent("123456")).toBeNull();
  });
});
