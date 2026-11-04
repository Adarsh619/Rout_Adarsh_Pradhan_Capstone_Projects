import type { Storage } from "../../lib/s3.js";

// Only these image types, each with the extension its key gets. SVG is excluded on purpose: it can carry scripts.
export const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
export type ImageType = keyof typeof IMAGE_TYPES;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const UPLOAD_URL_TTL_SECONDS = 300;

// Every vendor's files live under their own prefix, so a key can't point at another store's photo.
export const UPLOAD_PURPOSES = {
  "product-image": (vendorId: string) => `products/${vendorId}/`,
  "store-logo": (vendorId: string) => `stores/${vendorId}/`,
} as const;
export type UploadPurpose = keyof typeof UPLOAD_PURPOSES;

const isImageType = (t: string): t is ImageType => t in IMAGE_TYPES;

// Checks a key a vendor wants to attach: their own prefix, and a file that really was uploaded with an allowed type
// and size. The upload link already limits both, but the check is repeated here because it's the one the API controls
// (and the local S3 mock doesn't verify signatures). Returns a message for the form, or null when it's fine.
export async function checkUploadedImage(storage: Storage, key: string, prefix: string): Promise<string | null> {
  if (!key.startsWith(prefix) || key.includes("..")) return "This photo doesn't belong to your store";
  const obj = await storage.head(key);
  if (!obj) return "This photo didn't finish uploading. Please upload it again";
  if (!isImageType(obj.contentType)) return "Photos must be JPEG, PNG or WebP";
  if (obj.size > MAX_IMAGE_BYTES) return "Photos must be 5 MB or smaller";
  return null;
}
