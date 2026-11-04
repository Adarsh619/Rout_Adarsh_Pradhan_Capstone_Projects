import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "../config/env.js";
import { logger } from "./logger.js";

// The same code talks to the local S3 mock (S3_ENDPOINT set, path-style URLs) and to real AWS S3 (no endpoint).
export function createS3(env: Env, endpoint = env.S3_ENDPOINT): S3Client {
  return new S3Client({
    region: env.S3_REGION,
    ...(endpoint && { endpoint }),
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    // Otherwise the SDK puts a checksum of an *empty* body into presigned upload links, and real S3 then
    // rejects the browser's upload (the local mock doesn't check, so only AWS would show the bug).
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
}

export async function pingS3(s3: S3Client, bucket: string): Promise<void> {
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
}

export async function ensureBucket(s3: S3Client, bucket: string): Promise<void> {
  try {
    await pingS3(s3, bucket);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export interface StoredObject {
  contentType: string;
  size: number;
}

// Everything the API does with files, behind one interface so unit tests can use an in-memory fake.
export interface Storage {
  // A short-lived URL the browser PUTs one file to. Content type and exact size are part of the signature.
  presignPut(key: string, contentType: string, size: number, expiresInSeconds: number): Promise<string>;
  // What was actually uploaded under a key, or null if nothing was.
  head(key: string): Promise<StoredObject | null>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  // Best effort: a leftover file costs a few bytes, a failed request must never fail the user's action.
  deleteMany(keys: string[]): Promise<void>;
  publicUrl(key: string): string;
}

export function createStorage(env: Env, client: S3Client = createS3(env)): Storage {
  const bucket = env.S3_BUCKET;
  // Upload links must point at an address the browser can reach, which in Docker isn't the API's own.
  const signer = env.S3_PUBLIC_ENDPOINT ? createS3(env, env.S3_PUBLIC_ENDPOINT) : client;
  const publicEndpoint = env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT;
  const publicBase = (
    env.S3_PUBLIC_URL ??
    (publicEndpoint ? `${publicEndpoint}/${bucket}` : `https://${bucket}.s3.${env.S3_REGION}.amazonaws.com`)
  ).replace(/\/$/, "");

  return {
    presignPut: (key, contentType, size, expiresIn) =>
      getSignedUrl(signer, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: size }), {
        expiresIn,
        signableHeaders: new Set(["content-type", "content-length"]),
      }),

    head: async (key) => {
      try {
        const h = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { contentType: h.ContentType ?? "", size: h.ContentLength ?? 0 };
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404 || (err as { name?: string }).name === "NotFound") return null;
        throw err;
      }
    },

    put: async (key, body, contentType) => {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },

    deleteMany: async (keys) => {
      if (keys.length === 0) return;
      try {
        await client.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }),
        );
      } catch (err) {
        logger.warn({ err, keys }, "could not delete files from storage");
      }
    },

    publicUrl: (key) => `${publicBase}/${key.split("/").map(encodeURIComponent).join("/")}`,
  };
}
