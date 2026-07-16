/**
 * Flyer/offer photo storage for in-store visits (Supabase Storage).
 *
 * Instead of marking each product's promo, workers upload photos of the store's
 * folletos/ofertas during a visit. We accept the raw image bytes, sniff the
 * format, upload to a public bucket, and return the public URL to store on the
 * instore_photos row.
 */

import { randomUUID } from 'node:crypto';
import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { detectImage } from '../revistas/image.js';

const BUCKET = 'instore-photos';
let bucketReady = false;

/** Create the public bucket on first use (idempotent — ignores "already exists"). */
async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const { error } = await db.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: '15MB',
  });
  if (error && !/exist/i.test(error.message)) {
    logger.warn({ err: error, bucket: BUCKET }, 'instore: ensureBucket failed (continuing)');
  }
  bucketReady = true;
}

/** True if the buffer starts with the magic bytes of a supported image format. */
function isSupportedImage(buf: Buffer): boolean {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return true; // WEBP
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  return false;
}

export interface UploadedPhoto {
  url: string;
  storagePath: string;
}

/**
 * Upload one flyer photo for a visit. Returns the public URL + storage path.
 * Throws if the bytes aren't a recognized image or the upload fails.
 */
export async function uploadVisitPhoto(
  visitId: string,
  image: Buffer,
): Promise<UploadedPhoto> {
  if (!isSupportedImage(image)) {
    throw new Error('Unsupported image format (expected PNG, JPEG, WebP or GIF)');
  }
  await ensureBucket();
  const { ext, mime } = detectImage(image);
  const storagePath = `${visitId}/${randomUUID()}.${ext}`;

  const { error } = await db.storage
    .from(BUCKET)
    .upload(storagePath, image, { contentType: mime, upsert: false });
  if (error) throw error;

  const url = db.storage.from(BUCKET).getPublicUrl(storagePath).data.publicUrl;
  return { url, storagePath };
}
