import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { fileLocationCommand, openFileLocation } from "./workspace-opener.js";

describe("workspace opener", () => {
  it("uses the native file manager command for each supported desktop", () => {
    expect(fileLocationCommand("darwin")).toEqual({ command: "open", args: [] });
    expect(fileLocationCommand("win32")).toEqual({ command: "explorer.exe", args: [] });
    expect(fileLocationCommand("linux")).toEqual({ command: "xdg-open", args: [] });
  });

  it("resolves when the file manager is spawned even if explorer later exits non-zero", async () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn(() => child);
    const spawnProcess = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const opening = openFileLocation("C:\\workspace\\order-dashboard", "win32", spawnProcess);
    child.emit("spawn");

    await expect(opening).resolves.toBeUndefined();
    expect(spawnProcess).toHaveBeenCalledWith(
      "explorer.exe",
      ["C:\\workspace\\order-dashboard"],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("rejects when the desktop file manager cannot be spawned", async () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn(() => child);
    const spawnProcess = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const opening = openFileLocation("/workspace/order-dashboard", "linux", spawnProcess);
    const error = new Error("xdg-open not found");
    child.emit("error", error);

    await expect(opening).rejects.toBe(error);
    expect(child.unref).not.toHaveBeenCalled();
  });
});
