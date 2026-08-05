/**
 * Page-image storage in Supabase Storage. The review UI shows the operator the
 * exact page the AI read, so each rendered page is uploaded and a public URL is
 * stored on the review item.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { revistaConfig } from './config.js';
import { detectImage } from './image.js';

let bucketReady = false;

/** Create the public bucket on first use (idempotent — ignores "already exists"). */
async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const { error } = await db.storage.createBucket(revistaConfig.storageBucket, {
    public: true,
    fileSizeLimit: '15MB',
  });
  // "already exists" is the happy path on every run after the first.
  if (error && !/exist/i.test(error.message)) {
    logger.warn({ err: error, bucket: revistaConfig.storageBucket }, 'revista: ensureBucket failed (continuing)');
  }
  bucketReady = true;
}

/** Upload one page image; returns its public URL (or null if upload failed). */
export async function uploadPageImage(
  magazineId: string,
  pageNumber: number,
  image: Buffer,
): Promise<string | null> {
  await ensureBucket();
  const { ext, mime } = detectImage(image);
  const path = `${magazineId}/page-${String(pageNumber).padStart(3, '0')}.${ext}`;

  const { error } = await db.storage
    .from(revistaConfig.storageBucket)
    .upload(path, image, { contentType: mime, upsert: true });
  if (error) {
    logger.warn({ err: error, path }, 'revista: page image upload failed');
    return null;
  }
  return db.storage.from(revistaConfig.storageBucket).getPublicUrl(path).data.publicUrl;
}

/**
 * Delete every uploaded page image for a magazine (frees Storage space when an
 * operator deletes a flyer they don't care about). Best-effort: logs and returns
 * 0 on failure instead of throwing, so a Storage hiccup never blocks the DB
 * delete.
 */
export async function deleteMagazineImages(magazineId: string): Promise<number> {
  await ensureBucket();
  const bucket = revistaConfig.storageBucket;

  // Storage `list()` returns 100 entries by DEFAULT. Deleting a 144-page
  // Rosental quincena on 2026-08-05 removed exactly 100 files and silently left
  // 44 behind, so anything over 100 pages has been leaking since this existed.
  // Page until a short batch comes back.
  const PAGE = 1000;
  const paths: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db.storage.from(bucket).list(magazineId, { limit: PAGE, offset });
    if (error) {
      logger.warn({ err: error, magazineId }, 'revista: list page images failed (continuing)');
      return 0;
    }
    const batch = data ?? [];
    for (const f of batch) paths.push(`${magazineId}/${f.name}`);
    if (batch.length < PAGE) break;
  }
  if (paths.length === 0) return 0;

  // `remove()` takes a list; keep the request bounded for very long magazines.
  let removed = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const { error: rmErr } = await db.storage.from(bucket).remove(chunk);
    if (rmErr) {
      logger.warn({ err: rmErr, magazineId }, 'revista: remove page images failed (continuing)');
      return removed;
    }
    removed += chunk.length;
  }
  return removed;
}
