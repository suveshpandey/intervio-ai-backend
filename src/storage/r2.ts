import {
  HeadBucketCommand,
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { env, r2Enabled } from '@/config/env';
import { AppError } from '@/common/errors';

// Cloudflare R2 is S3-compatible; upload/download logic lands in Phase 1.
// Phase 0 only wires the client so credentials can be verified.
export const r2 = r2Enabled
  ? new S3Client({
      region: 'auto',
      endpoint: env.R2_ENDPOINT,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID!,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      },
    })
  : null;

/** Verifies the bucket is reachable with the configured credentials. */
export async function checkR2(): Promise<boolean> {
  if (!r2) return false;
  try {
    await r2.send(new HeadBucketCommand({ Bucket: env.R2_BUCKET }));
    return true;
  } catch {
    return false;
  }
}

function client(): S3Client {
  if (!r2) throw new AppError(503, 'Object storage is not configured', 'storage_disabled');
  return r2;
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await client().send(
    new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function getObject(key: string): Promise<Buffer> {
  const res = await client().send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

export async function deleteObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
}
