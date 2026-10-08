import {
  ModalClient,
  NotFoundError,
  type Image,
  type Sandbox,
} from "modal";
import {
  MODAL_APP_NAME,
  toolchainDockerfile,
  toolchainImageName,
  type ModalApi,
  type ModalBox,
  type ModalCreateParams,
  type ModalDirEntry,
  type ModalImageRef,
  type ModalProc,
} from "./modal.js";

/**
 * The real Modal client. Tokens are arguments. This file is the only
 * place the SDK is imported, so unit tests that pass a fake `ModalApi`
 * never load it and never need credentials.
 */
export async function createModalApi(options: {
  tokenId: string;
  tokenSecret: string;
  environment?: string;
}): Promise<ModalApi> {
  const client = new ModalClient({
    tokenId: options.tokenId,
    tokenSecret: options.tokenSecret,
    ...(options.environment ? { environment: options.environment } : {}),
  });
  const app = await client.apps.fromName(MODAL_APP_NAME, {
    createIfMissing: true,
    ...(options.environment ? { environment: options.environment } : {}),
  });
  const built = new Map<string, Promise<ModalImageRef>>();

  function imageParams(): { environment: string } | undefined {
    return options.environment ? { environment: options.environment } : undefined;
  }

  async function toolchainImage(binaries: readonly string[]): Promise<ModalImageRef> {
    const name = toolchainImageName(binaries);
    const cached = built.get(name);
    if (cached) return cached;
    const pending = publishToolchain(name, binaries).catch((err: unknown) => {
      built.delete(name);
      throw err;
    });
    built.set(name, pending);
    return pending;
  }

  async function publishToolchain(name: string, binaries: readonly string[]): Promise<ModalImageRef> {
    try {
      const existing = await client.images.fromName(name, imageParams());
      return { imageId: existing.imageId };
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    const image = await client.images
      .fromRegistry("ubuntu:24.04")
      .dockerfileCommands(toolchainDockerfile(binaries))
      .build(app);
    try {
      await image.publish(name, imageParams());
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      const existing = await client.images.fromName(name, imageParams());
      return { imageId: existing.imageId };
    }
    return { imageId: image.imageId };
  }

  return {
    async fromName(name) {
      try {
        const sandbox = await client.sandboxes.fromName(MODAL_APP_NAME, name, imageParams());
        return wrapSandbox(client, sandbox);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async create(imageRef, params) {
      const image = await client.images.fromId(imageRef.imageId);
      const sandbox = await client.sandboxes.create(app, image, createParams(params));
      return wrapSandbox(client, sandbox);
    },
    async imageFromId(id) {
      try {
        const image = await client.images.fromId(id);
        return { imageId: image.imageId };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async deleteImage(id) {
      try {
        await client.images.delete(id);
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
    },
    toolchainImage,
    async listRunning() {
      const found: { externalId: string; tags: Record<string, string> }[] = [];
      for await (const sandbox of client.sandboxes.list({
        appId: app.appId,
        ...(options.environment ? { environment: options.environment } : {}),
      })) {
        const tags = await sandbox.getTags();
        const featureId = tags.bento_feature;
        if (!featureId) continue;
        found.push({ externalId: `bento-${featureId}`, tags });
      }
      return found;
    },
  };
}

/**
 * What sandboxes.create receives. idleTimeoutMs is omitted on purpose:
 * a daemonized agent does not count as activity, and a dropped follow
 * exec would idle-kill the machine.
 */
function createParams(params: ModalCreateParams) {
  return {
    name: params.name,
    cpu: params.cpu,
    memoryMiB: params.memoryMiB,
    timeoutMs: params.timeoutMs,
    workdir: params.workdir,
    tags: params.tags,
    experimentalOptions: params.experimentalOptions,
    ...(params.outboundDomainAllowlist ? { outboundDomainAllowlist: params.outboundDomainAllowlist } : {}),
  };
}

function wrapSandbox(client: ModalClient, sandbox: Sandbox): ModalBox {
  return {
    sandboxId: sandbox.sandboxId,
    poll: () => sandbox.poll(),
    terminate: () => sandbox.terminate(),
    getTags: () => sandbox.getTags(),
    async exec(argv, params) {
      const shared = {
        ...(params?.workdir ? { workdir: params.workdir } : {}),
        ...(params?.env ? { env: params.env } : {}),
        ...(params?.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      };
      if (params?.binary) {
        const proc = await sandbox.exec(argv, { ...shared, mode: "binary" });
        return adaptProc(proc, true);
      }
      const proc = await sandbox.exec(argv, { ...shared, mode: "text" });
      return adaptProc(proc, false);
    },
    async readText(path) {
      try {
        return await sandbox.filesystem.readText(path);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    readBytes: (path) => sandbox.filesystem.readBytes(path),
    writeBytes: (data, path) => sandbox.filesystem.writeBytes(data, path),
    async listDir(path): Promise<ModalDirEntry[]> {
      const entries = await sandbox.filesystem.listFiles(path);
      return entries.map((entry) => ({ name: entry.name, type: entry.type }));
    },
    remove: (path, options) => sandbox.filesystem.remove(path, options?.recursive ? { recursive: true } : undefined),
    async snapshotDirectory(path, params) {
      const image = await sandbox.snapshotDirectory(path, params);
      return imageRefOf(image);
    },
    async snapshotFilesystem(params) {
      const image = await sandbox.snapshotFilesystem(params);
      return imageRefOf(image);
    },
    async mountImage(path, image) {
      const resolved = await client.images.fromId(image.imageId);
      await sandbox.mountImage(path, resolved);
    },
    async experimentalGetExitSnapshot() {
      return imageRefOf(await sandbox.experimentalGetExitSnapshot());
    },
  };
}

function imageRefOf(image: Image): ModalImageRef {
  return { imageId: image.imageId };
}

export function adaptProc(
  proc: {
    stdout: { readText(): Promise<string> } & ReadableStream<Uint8Array | string>;
    stderr: { readText(): Promise<string> };
    stdin: { writeText(text: string): Promise<void>; close(): Promise<void> };
    closeStdin(): Promise<void>;
    wait(): Promise<number>;
  },
  binary: boolean,
): ModalProc {
  return {
    async *stdout() {
      if (!binary) return;
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) return;
          if (next.value) yield next.value;
        }
      } finally {
        reader.releaseLock();
      }
    },
    stdoutText: () => proc.stdout.readText(),
    stderrText: () => proc.stderr.readText(),
    wait: () => proc.wait(),
    writeStdin: (text) => proc.stdin.writeText(text),
    /*
     * The stream's own close, never closeStdin(). In modal 0.10.1
     * closeStdin() sends EOF at offset 0, which is meant for a stream
     * whose first write failed: after N bytes were written the server
     * drops it as stale, and the SDK swallows the error. bento-exec
     * stdin then never saw EOF, so a command fed through stdin (every
     * sandbox file write) waited forever and the run hung with no log
     * line. close() sends EOF at the offset the writes reached.
     * closeStdin() stays as the fallback for a stream that errored and
     * cannot close.
     */
    endStdin: async () => {
      try {
        await proc.stdin.close();
      } catch {
        await proc.closeStdin();
      }
    },
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof NotFoundError || (err instanceof Error && err.name.includes("NotFound"));
}

function isAlreadyExists(err: unknown): boolean {
  return err instanceof Error && (err.name === "AlreadyExistsError" || err.message.includes("AlreadyExists"));
}
