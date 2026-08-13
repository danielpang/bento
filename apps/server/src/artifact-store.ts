import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import type { Env } from "./env.js";

/**
 * Where binary artifacts live: the bytes only, never the authority.
 *
 * Who may read an artifact is decided by its run_artifacts row in
 * Postgres, behind the same access helpers and row-level security as
 * every other tenant row. The store is a dumb shelf: keys are
 * server-generated, org-prefixed for lifecycle bookkeeping, and no key
 * is ever derived from anything an agent wrote.
 *
 * Two implementations, chosen at boot. Multi mode wants an
 * S3-compatible bucket (Tigris via `fly storage create`, or anything
 * else that speaks S3), because the machine's own disk does not survive
 * a deploy. Local mode uses the data directory, the same way it brings
 * its own Postgres.
 */
export interface ArtifactStore {
  /** One line for the startup log, so the operator can see where bytes go. */
  description: string;
  put(key: string, data: Buffer, mime: string): Promise<void>;
  /** Null when the object is gone, which callers report rather than hide. */
  get(key: string): Promise<Buffer | null>;
  remove(keys: string[]): Promise<void>;
}

/**
 * Keys are minted by the server, so a bad one is a bug, not input to
 * tolerate. Checked anyway: this is the only line between a key and the
 * filesystem in the disk store.
 */
function assertSafeKey(key: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(key) || key.split("/").includes("..")) {
    throw new Error(`unsafe artifact key: ${key}`);
  }
}

export class DiskArtifactStore implements ArtifactStore {
  readonly description: string;
  private root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "artifacts");
    this.description = this.root;
  }

  async put(key: string, data: Buffer): Promise<void> {
    assertSafeKey(key);
    const file = path.join(this.root, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  async get(key: string): Promise<Buffer | null> {
    assertSafeKey(key);
    try {
      return await readFile(path.join(this.root, key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) {
      assertSafeKey(key);
      await rm(path.join(this.root, key), { force: true });
    }
  }
}

export interface S3StoreOptions {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Any S3-compatible bucket over plain signed HTTP. aws4fetch rather
 * than the AWS SDK: four verbs do not need a hundred transitive
 * dependencies, and Tigris, R2, and S3 itself all answer the same
 * requests.
 */
export class S3ArtifactStore implements ArtifactStore {
  readonly description: string;
  private client: AwsClient;
  private base: string;

  constructor(options: S3StoreOptions) {
    this.client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: options.region,
      service: "s3",
    });
    this.base = `${options.endpoint.replace(/\/$/, "")}/${options.bucket}`;
    this.description = this.base;
  }

  private url(key: string): string {
    assertSafeKey(key);
    return `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async put(key: string, data: Buffer, mime: string): Promise<void> {
    const res = await this.client.fetch(this.url(key), {
      method: "PUT",
      headers: { "content-type": mime, "content-length": String(data.byteLength) },
      body: new Uint8Array(data),
    });
    if (!res.ok) throw new Error(`artifact store PUT ${key} answered ${res.status}: ${await res.text()}`);
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.client.fetch(this.url(key), { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`artifact store GET ${key} answered ${res.status}: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) {
      const res = await this.client.fetch(this.url(key), { method: "DELETE" });
      // 404 means already gone, which is what remove wanted.
      if (!res.ok && res.status !== 404) {
        throw new Error(`artifact store DELETE ${key} answered ${res.status}`);
      }
    }
  }
}

/**
 * Boot-time choice of store. An S3 bucket wins whenever one is fully
 * configured; the BENTO_ARTIFACTS_* names take precedence, and the
 * plain AWS_* / BUCKET_NAME names are what `fly storage create`
 * injects, so a Tigris bucket works with no mapping at all. Local mode
 * falls back to the data directory. Multi mode without a bucket gets
 * null: the deploy's disk is ephemeral, and quietly writing artifacts
 * there would look like a working feature until the next deploy ate
 * the files.
 */
export function createArtifactStore(env: Env): ArtifactStore | null {
  const bucket = env.BENTO_ARTIFACTS_BUCKET ?? env.BUCKET_NAME;
  const endpoint = env.BENTO_ARTIFACTS_ENDPOINT ?? env.AWS_ENDPOINT_URL_S3;
  const accessKeyId = env.BENTO_ARTIFACTS_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.BENTO_ARTIFACTS_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;
  if (bucket && endpoint && accessKeyId && secretAccessKey) {
    return new S3ArtifactStore({
      bucket,
      endpoint,
      accessKeyId,
      secretAccessKey,
      region: env.BENTO_ARTIFACTS_REGION ?? env.AWS_REGION ?? "auto",
    });
  }
  if (env.BENTO_MODE !== "multi") return new DiskArtifactStore(env.BENTO_DATA_DIR);
  return null;
}
