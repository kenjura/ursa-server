/**
 * `s3` sink: any S3-compatible store (AWS, R2, B2, MinIO), optionally behind
 * CloudFront. docs/WATCHER.md#sink-modes.
 *
 * Credentials come from the AWS default chain (env, shared profile, instance
 * role) unless `credentials` is given. The IAM policy the server needs:
 * s3:PutObject, s3:DeleteObject, s3:ListBucket on the bucket/prefix, and
 * cloudfront:CreateInvalidation on the distribution.
 */

import { S3Client, PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import mime from "mime-types";

const DELETE_BATCH = 1000;

/**
 * @param {object} config - normalised `sink` block
 * @param {{ s3?: object, cloudfront?: object }} [clients] - injected clients (tests)
 * @returns {import("../types.js").SinkAdapter}
 */
export function createS3Sink(config, clients = {}) {
  const credentials = config.credentials?.accessKeyId
    ? {
        accessKeyId: config.credentials.accessKeyId,
        secretAccessKey: config.credentials.secretAccessKey,
        sessionToken: config.credentials.sessionToken,
      }
    : undefined;
  if (config.credentials?.profile) process.env.AWS_PROFILE ??= config.credentials.profile;
  const s3 = clients.s3 ?? new S3Client({
    region: config.region ?? process.env.AWS_REGION ?? "us-east-1",
    endpoint: config.endpoint ?? undefined,
    forcePathStyle: config.forcePathStyle,
    credentials,
  });
  const cf = config.cloudfront ? (clients.cloudfront ?? new CloudFrontClient({ region: "us-east-1", credentials })) : null;
  const key = (rel) => config.prefix + rel;

  function cacheControlFor(rel) {
    if (rel.endsWith(".html")) return config.cacheControl.html;
    if (rel.endsWith(".json")) return config.cacheControl.json;
    return config.cacheControl.assets;
  }

  return {
    id: `s3:${config.endpoint ?? ""}/${config.bucket}/${config.prefix}`,
    inPlace: false,
    async init() {},

    async put(rel, absPath) {
      const { size } = await stat(absPath);
      await s3.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key(rel),
        Body: createReadStream(absPath),
        ContentLength: size,
        ContentType: mime.contentType(rel.split("/").pop()) || "application/octet-stream",
        CacheControl: cacheControlFor(rel),
      }));
    },

    async remove(rels) {
      for (let i = 0; i < rels.length; i += DELETE_BATCH) {
        const batch = rels.slice(i, i + DELETE_BATCH);
        const res = await s3.send(new DeleteObjectsCommand({
          Bucket: config.bucket,
          Delete: { Objects: batch.map((r) => ({ Key: key(r) })), Quiet: true },
        }));
        if (res.Errors?.length) {
          const e = res.Errors[0];
          throw new Error(`delete ${e.Key}: ${e.Code} ${e.Message ?? ""}`.trim());
        }
      }
    },

    /** The bucket's objects under the prefix with their MD5 (ETag), for reconciliation. */
    async list() {
      const out = new Map();
      let ContinuationToken;
      do {
        const res = await s3.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: config.prefix || undefined, ContinuationToken }));
        for (const o of res.Contents ?? []) {
          const rel = o.Key.slice(config.prefix.length);
          // A multipart ETag ("…-3") is not an MD5; it will simply never match
          if (rel) out.set(rel, (o.ETag ?? "").replace(/"/g, ""));
        }
        ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return out;
    },

    /** Invalidate CloudFront for the paths a deploy changed. */
    async commit(changed) {
      if (!cf || changed.length === 0) return null;
      const paths = invalidationPaths(changed, config.prefix);
      const Items = paths.length > config.cloudfront.maxPaths ? [`/${config.prefix}*`] : paths;
      await cf.send(new CreateInvalidationCommand({
        DistributionId: config.cloudfront.distributionId,
        InvalidationBatch: { CallerReference: `ursa-server-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, Paths: { Quantity: Items.length, Items } },
      }));
      return Items;
    },

    describe: () => `s3://${config.bucket}/${config.prefix}${config.cloudfront ? ` (CloudFront ${config.cloudfront.distributionId})` : ""}`,
  };
}

/**
 * CloudFront paths for changed output files. A page is reachable by more than
 * one URL (`/a/b.html`, `/a/b`; `/a/index.html`, `/a/`), and each is cached
 * separately, so every form is invalidated.
 */
export function invalidationPaths(rels, prefix = "") {
  const out = new Set();
  for (const rel of rels) {
    const p = `/${prefix}${rel}`;
    out.add(encodeURI(p));
    if (rel.endsWith(".html")) {
      const bare = p.slice(0, -".html".length);
      out.add(encodeURI(bare));
      if (rel === "index.html" || rel.endsWith("/index.html")) out.add(encodeURI(bare.slice(0, -"index".length)));
    }
  }
  return [...out].sort();
}
