import { describe, expect, it } from "vitest";
import {
  parseAuthenticatorCode,
  parseProtectedCapabilityGrantIntent,
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

  it("recognizes one-hour capability requests and six-digit codes", () => {
    expect(parseProtectedCapabilityGrantIntent(
      "grant write access to Alice's private notes for 1 hour",
    )).toEqual({
      kind: "grant-capability",
      resourceType: "mock_record",
      resourceKey: "alice-private-note",
      actions: ["write"],
      expiresInSeconds: 3_600,
    });
    expect(parseProtectedCapabilityGrantIntent(
      "grant read access to shared-status for 1 hour",
    )).toEqual({
      kind: "grant-capability",
      resourceType: "mock_record",
      resourceKey: "shared-status",
      actions: ["read"],
      expiresInSeconds: 3_600,
    });
    expect(parseProtectedCapabilityGrantIntent(
      "grant read and write access to Alice's private notes for 1 hour",
    )).toEqual({
      kind: "grant-capability",
      resourceType: "mock_record",
      resourceKey: "alice-private-note",
      actions: ["read", "write"],
      expiresInSeconds: 3_600,
    });
    expect(parseAuthenticatorCode("246810")).toBe("246810");
    expect(parseAuthenticatorCode("authenticator code: 246810")).toBe("246810");
    expect(parseAuthenticatorCode("24681")).toBeNull();
  });
});
