import { describe, expect, it } from "vitest";
import { fileLocationCommand } from "./workspace-opener.js";

describe("workspace opener", () => {
  it("uses the native file manager command for each supported desktop", () => {
    expect(fileLocationCommand("darwin")).toEqual({ command: "open", args: [] });
    expect(fileLocationCommand("win32")).toEqual({ command: "explorer.exe", args: [] });
    expect(fileLocationCommand("linux")).toEqual({ command: "xdg-open", args: [] });
  });
});
