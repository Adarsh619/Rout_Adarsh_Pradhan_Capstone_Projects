import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import type { Env } from "../config/env.js";

// The same code talks to the local S3 mock (S3_ENDPOINT set, path-style URLs) and to real AWS S3 (no endpoint).
export function createS3(env: Env): S3Client {
  return new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT && { endpoint: env.S3_ENDPOINT }),
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
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
