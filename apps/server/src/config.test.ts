import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("startup demo-data seeding", () => {
  it("enables deterministic seed data in development by default", () => {
    expect(loadConfig({ NODE_ENV: "development" }).seedDevelopmentData).toBe(true);
  });

  it("keeps seed data disabled for production by default", () => {
    expect(
      loadConfig({ NODE_ENV: "production", HOST: "127.0.0.1" }).seedDevelopmentData,
    ).toBe(false);
  });

  it("allows the local POC to seed while retaining production Runtime mode", () => {
    expect(
      loadConfig({
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        SEED_DEVELOPMENT_DATA: "true",
      }).seedDevelopmentData,
    ).toBe(true);
  });

  it("allows an explicitly empty local database", () => {
    expect(
      loadConfig({ NODE_ENV: "development", SEED_DEVELOPMENT_DATA: "false" })
        .seedDevelopmentData,
    ).toBe(false);
  });
});
