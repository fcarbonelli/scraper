/**
 * Page-image storage in Supabase Storage. The review UI shows the operator the
 * exact page the AI read, so each rendered page is uploaded and a public URL is
 * stored on the review item.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { revistaConfig } from './config.js';
import { detectImage } from './image.js';
import { withRetry } from './retry.js';

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

  // Storage throws transient 520s mid-run (2026-10-19 lost page 28 of a
  // 166-page Rosental issue to one); StorageApiError carries `status`, so
  // withRetry retries 5xx and gives up on real 4xx.
  try {
    await withRetry(
      async () => {
        const { error } = await db.storage
          .from(revistaConfig.storageBucket)
          .upload(path, image, { contentType: mime, upsert: true });
        if (error) throw error;
      },
      { label: `upload ${path}` },
    );
  } catch (err) {
    logger.warn({ err, path }, 'revista: page image upload failed');
    return null;
  }
  return db.storage.from(revistaConfig.storageBucket).getPublicUrl(path).data.publicUrl;
}

/**
 * Every file stored under a magazine's folder. Storage `list()` returns 100
 * entries by DEFAULT (that silently truncated a 144-page delete on 2026-08-05),
 * so page until a short batch comes back. Returns null when Storage errors.
 */
async function listMagazineFiles(magazineId: string): Promise<string[] | null> {
  const PAGE = 1000;
  const names: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db.storage
      .from(revistaConfig.storageBucket)
      .list(magazineId, { limit: PAGE, offset });
    if (error) {
      logger.warn({ err: error, magazineId }, 'revista: list page images failed');
      return null;
    }
    const batch = data ?? [];
    for (const f of batch) names.push(f.name);
    if (batch.length < PAGE) break;
  }
  return names;
}

/**
 * Page-image URLs rebuilt from what is actually in Storage, sorted by page.
 * The fallback for magazines whose `metadata.page_images` never got written
 * (Rosental 2026-09-21 and 2026-10-19: all pages uploaded, metadata empty).
 */
export async function listMagazinePageImages(
  magazineId: string,
): Promise<Array<{ page: number; url: string }>> {
  const names = (await listMagazineFiles(magazineId)) ?? [];
  const bucket = db.storage.from(revistaConfig.storageBucket);
  return names
    .map((name) => ({ name, page: Number(name.match(/^page-(\d+)\./)?.[1]) }))
    .filter((f) => Number.isInteger(f.page) && f.page > 0)
    .sort((a, b) => a.page - b.page)
    .map((f) => ({ page: f.page, url: bucket.getPublicUrl(`${magazineId}/${f.name}`).data.publicUrl }));
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

  const names = await listMagazineFiles(magazineId);
  if (!names || names.length === 0) return 0;
  const paths = names.map((n) => `${magazineId}/${n}`);

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
