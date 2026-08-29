import { describe, expect, it } from "vitest";
import { parseProtectedResourceIntent } from "./protected-resource-intent.js";

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

  it("recognizes the allowlisted data-asset resources", () => {
    expect(parseProtectedResourceIntent("read the order API contract")).toEqual({
      resourceType: "data_asset",
      resourceKey: "order-schema",
      action: "read",
    });
    expect(parseProtectedResourceIntent("show customer records")).toEqual({
      resourceType: "data_asset",
      resourceKey: "customer-records",
      action: "read",
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
});
