import { spawn } from "node:child_process";

export async function openUrl(value: string): Promise<void> {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Only HTTP and HTTPS links can be opened.");
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url.href] : [url.href];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Could not open the browser. Open the displayed address manually.")),
    );
  });
}
