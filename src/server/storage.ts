import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  ListMultipartUploadsCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  GetBucketReplicationCommand,
  ListObjectVersionsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyStatusCommand,
  GetBucketAclCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { Config } from "./config";
import type { Source } from "../crypto/bytes";
export interface Storage {
  upload(
    key: string,
    source: Source,
    expected: number,
    hash: string,
    signal: AbortSignal,
    started: (id: string) => Promise<void>,
    activity: () => Promise<void>,
  ): Promise<void>;
  get(key: string, signal: AbortSignal): Promise<Readable>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  objects(): AsyncIterable<{ key: string; at: Date }>;
  multiparts(): AsyncIterable<{ key: string; id: string; at: Date }>;
  abort(key: string, id: string): Promise<void>;
}
export class S3Storage implements Storage {
  client: S3Client;
  bucket: string;
  constructor(config: Config) {
    this.bucket = config.s3Bucket;
    this.client = new S3Client({
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      credentials: {
        accessKeyId: config.s3AccessKey,
        secretAccessKey: config.s3SecretKey,
      },
      forcePathStyle: true,
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 60000 },
    });
  }
  async upload(
    key: string,
    source: Source,
    expected: number,
    hash: string,
    signal: AbortSignal,
    started: (id: string) => Promise<void>,
    activity: () => Promise<void>,
  ) {
    const Bucket = this.bucket,
      Key = key;
    const init = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket,
        Key,
        ContentType: "application/octet-stream",
      }),
      { abortSignal: signal },
    );
    const UploadId = init.UploadId!;
    try {
      await started(UploadId);
      const parts: { ETag: string; PartNumber: number }[] = [];
      const buffer = Buffer.alloc(8 * 1048576);
      let used = 0,
        total = 0,
        last = 0;
      const sha = createHash("sha256");
      const flush = async () => {
        const PartNumber = parts.length + 1;
        const part = await this.client.send(
          new UploadPartCommand({
            Bucket,
            Key,
            UploadId,
            PartNumber,
            Body: buffer.subarray(0, used),
            ContentLength: used,
          }),
          { abortSignal: signal },
        );
        parts.push({ ETag: part.ETag!, PartNumber });
        used = 0;
      };
      for await (const b of source) {
        if (signal.aborted) throw new Error("Upload cancelled");
        total += b.length;
        if (total > expected) throw new Error("Upload length invalid");
        sha.update(b);
        if (Date.now() - last > 2000) {
          await activity();
          last = Date.now();
        }
        let p = 0;
        while (p < b.length) {
          const n = Math.min(buffer.length - used, b.length - p);
          buffer.set(b.subarray(p, p + n), used);
          used += n;
          p += n;
          if (used === buffer.length) await flush();
        }
      }
      if (total !== expected || sha.digest("hex") !== hash)
        throw new Error("Upload integrity invalid");
      if (used) await flush();
      await activity();
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key,
          UploadId,
          MultipartUpload: { Parts: parts },
        }),
        { abortSignal: signal },
      );
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket, Key }),
        { abortSignal: signal },
      );
      if (head.ContentLength !== expected)
        throw new Error("Stored length invalid");
    } catch (e) {
      await this.abort(key, UploadId).catch(() => {});
      throw e;
    }
  }
  async get(key: string, signal: AbortSignal) {
    const r = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: signal },
    );
    if (!(r.Body instanceof Readable))
      throw new Error("Unsupported S3 response");
    return r.Body;
  }
  async remove(key: string) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
  async exists(key: string) {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404) return false;
      throw new Error("Storage absence unconfirmed");
    }
  }
  async *objects() {
    let ContinuationToken: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, ContinuationToken }),
      );
      for (const o of r.Contents ?? [])
        if (o.Key && o.LastModified) yield { key: o.Key, at: o.LastModified };
      ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
      if (r.IsTruncated && !ContinuationToken)
        throw new Error("Unbounded S3 pagination");
    } while (ContinuationToken);
  }
  async *multiparts() {
    let KeyMarker: string | undefined, UploadIdMarker: string | undefined;
    for (;;) {
      const r = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.bucket,
          KeyMarker,
          UploadIdMarker,
        }),
      );
      for (const u of r.Uploads ?? [])
        if (u.Key && u.UploadId && u.Initiated)
          yield { key: u.Key, id: u.UploadId, at: u.Initiated };
      if (!r.IsTruncated) break;
      if (!r.NextKeyMarker) throw new Error("Unbounded multipart pagination");
      KeyMarker = r.NextKeyMarker;
      UploadIdMarker = r.NextUploadIdMarker;
    }
  }
  async abort(key: string, id: string) {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: id,
        }),
      );
    } catch (e: any) {
      if (e.name !== "NoSuchUpload") throw e;
    }
  }
  async preflight() {
    const Bucket = this.bucket;
    const version = await this.client.send(
      new GetBucketVersioningCommand({ Bucket }),
    );
    if (version.Status)
      throw new Error("Versioned or suspended buckets are incompatible");
    const noConfig = async (command: any, codes: string[]) => {
      try {
        const r = await this.client.send(command);
        if (Object.keys(r).some((k) => k !== "$metadata"))
          throw new Error("Incompatible retained storage configuration");
      } catch (e: any) {
        if (!codes.includes(e.name))
          throw new Error("Storage configuration cannot be established");
      }
    };
    await noConfig(new GetObjectLockConfigurationCommand({ Bucket }), [
      "ObjectLockConfigurationNotFoundError",
    ]);
    try {
      const r = await this.client.send(
        new GetBucketReplicationCommand({ Bucket }),
      );
      const replication = r.ReplicationConfiguration;
      // ODF RGW returns HTTP 200 with an empty Role and no Rules for an
      // unconfigured bucket. AWS returns ReplicationConfigurationNotFoundError.
      if (
        replication &&
        (Object.keys(replication).some((k) => !["Role", "Rules"].includes(k)) ||
          (replication.Role !== undefined && replication.Role !== "") ||
          (replication.Rules !== undefined &&
            (!Array.isArray(replication.Rules) ||
              replication.Rules.length !== 0)))
      )
        throw new Error("Incompatible retained storage configuration");
    } catch (e: any) {
      if (e.name !== "ReplicationConfigurationNotFoundError")
        throw new Error(
          "Storage replication configuration cannot be established",
        );
    }
    await noConfig(new GetBucketLifecycleConfigurationCommand({ Bucket }), [
      "NoSuchLifecycleConfiguration",
    ]);
    let KeyMarker: string | undefined, VersionIdMarker: string | undefined;
    for (;;) {
      const versions = await this.client.send(
        new ListObjectVersionsCommand({ Bucket, KeyMarker, VersionIdMarker }),
      );
      if (
        versions.DeleteMarkers?.length ||
        versions.Versions?.some((v) => v.VersionId && v.VersionId !== "null")
      )
        throw new Error("Retained object versions found");
      if (!versions.IsTruncated) break;
      if (!versions.NextKeyMarker)
        throw new Error("Version pagination unavailable");
      KeyMarker = versions.NextKeyMarker;
      VersionIdMarker = versions.NextVersionIdMarker;
    }
    const acl = await this.client.send(new GetBucketAclCommand({ Bucket }));
    if (acl.Grants?.some((g) => g.Grantee?.URI))
      throw new Error("Public bucket ACL is incompatible");
    const policy = await this.client.send(
      new GetBucketPolicyStatusCommand({ Bucket }),
    );
    if (policy.PolicyStatus?.IsPublic !== false)
      throw new Error("Private bucket status unproven");
    return {
      versioning: "absent",
      retention: "absent",
      replication: "absent",
      public: false,
    };
  }
}
