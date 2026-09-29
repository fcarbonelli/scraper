/**
 * Smaller image URLs for the in-store review screen.
 *
 * Flyer photos live in our public Storage bucket. Supabase can resize them
 * via the image render endpoint so the review UI does not download the
 * original phone photo. Product `image_url`s are usually the supermarket's
 * own CDN — we don't re-host those, so the thumb is the original URL.
 */

const OBJECT_PUBLIC = '/storage/v1/object/public/';
const RENDER_PUBLIC = '/storage/v1/render/image/public/';

/** Default review thumbnail width (px). */
export const DEFAULT_THUMB_WIDTH = 480;

/**
 * Build a resized URL for a Supabase public object. Returns the input
 * unchanged when it isn't one of our Storage objects (external CDN).
 */
export function thumbUrl(publicUrl: string | null | undefined, width = DEFAULT_THUMB_WIDTH): string | null {
  if (!publicUrl) return null;
  const q = publicUrl.indexOf('?');
  const bare = q === -1 ? publicUrl : publicUrl.slice(0, q);
  const i = bare.indexOf(OBJECT_PUBLIC);
  if (i === -1) return publicUrl;
  const base = bare.slice(0, i);
  const path = bare.slice(i + OBJECT_PUBLIC.length);
  return `${base}${RENDER_PUBLIC}${path}?width=${width}&resize=contain`;
}
