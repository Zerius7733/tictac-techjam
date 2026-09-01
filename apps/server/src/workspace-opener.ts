import { spawn, type ChildProcess } from "node:child_process";

export interface FileLocationCommand {
  command: string;
  args: string[];
}

export function fileLocationCommand(platform: NodeJS.Platform): FileLocationCommand {
  if (platform === "darwin") return { command: "open", args: [] };
  if (platform === "win32") return { command: "explorer.exe", args: [] };
  return { command: "xdg-open", args: [] };
}

type SpawnProcess = typeof spawn;

/**
 * Launch the desktop file manager without waiting for it to exit.
 *
 * On Windows, explorer.exe commonly returns exit code 1 after successfully
 * opening a folder (especially when an Explorer window is already running).
 * Waiting for that exit code makes the API report a false 503. The relevant
 * success signal is the child process' `spawn` event; an `error` event still
 * reports a missing/unlaunchable file manager.
 */
function spawnFileManager(
  command: string,
  args: string[],
  spawnProcess: SpawnProcess,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child: ChildProcess = spawnProcess(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

/** Open a server-owned folder in the host operating system's file manager. */
export async function openFileLocation(
  location: string,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: SpawnProcess = spawn,
): Promise<void> {
  const { command, args } = fileLocationCommand(platform);
  await spawnFileManager(command, [...args, location], spawnProcess);
}
