import { api } from "./client";

// Must match the API's rules (backend/src/modules/uploads/upload-rules.ts); checked here first so the vendor gets
// an instant message instead of a failed upload.
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type UploadPurpose = "product-image" | "store-logo";

export function imageProblem(file: File): string | undefined {
  if (!IMAGE_TYPES.includes(file.type)) return `${file.name}: photos must be JPEG, PNG or WebP`;
  if (file.size > MAX_IMAGE_BYTES) return `${file.name}: photos must be 5 MB or smaller`;
  if (file.size === 0) return `${file.name} is empty`;
  return undefined;
}

interface Presigned {
  key: string;
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  url: string;
}

// 1. The API signs a link for exactly this file (type + size). 2. The browser PUTs the file straight to S3.
// The file never passes through our API. Returns the key to save with the product and a URL to preview it.
export async function uploadImage(file: File, purpose: UploadPurpose): Promise<{ key: string; url: string }> {
  const signed = await api<Presigned>("/uploads/presign", {
    method: "POST",
    body: JSON.stringify({ purpose, contentType: file.type, size: file.size }),
  });
  // Plain fetch, not api(): S3 must get no cookies and no extra headers, only the ones that were signed.
  const res = await fetch(signed.uploadUrl, { method: signed.method, headers: signed.headers, body: file });
  if (!res.ok) throw new Error(`${file.name} couldn't be uploaded (storage answered ${res.status})`);
  return { key: signed.key, url: signed.url };
}
