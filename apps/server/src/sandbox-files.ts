/**
 * The file writer lives with the drivers, so the real-sandbox tests in
 * @bento/sandbox exercise the same script the server runs.
 */
export { sandboxFileExists, writeSandboxFiles, type SandboxFile } from "@bento/sandbox";
