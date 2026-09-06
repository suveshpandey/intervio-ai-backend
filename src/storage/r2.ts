import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { env, r2Enabled } from '@/config/env';

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
