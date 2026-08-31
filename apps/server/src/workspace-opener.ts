import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FileLocationCommand {
  command: string;
  args: string[];
}

export function fileLocationCommand(platform: NodeJS.Platform): FileLocationCommand {
  if (platform === "darwin") return { command: "open", args: [] };
  if (platform === "win32") return { command: "explorer.exe", args: [] };
  return { command: "xdg-open", args: [] };
}

/** Open a server-owned folder in the host operating system's file manager. */
export async function openFileLocation(
  location: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const { command, args } = fileLocationCommand(platform);
  await execFileAsync(command, [...args, location], { timeout: 10_000 });
}
