import { randomBytes } from "node:crypto";

// "Vikram's Electronics & More!" → "vikrams-electronics-more". Used in store and product URLs.
export function slugify(text: string, maxLength = 60): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "item";
}

// The base slug if it's free, otherwise base-2, base-3 …, and a random suffix as a last resort.
export async function uniqueSlug(text: string, isTaken: (slug: string) => Promise<boolean>): Promise<string> {
  const base = slugify(text);
  if (!(await isTaken(base))) return base;
  for (let n = 2; n <= 20; n++) {
    const candidate = `${base}-${n}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  return `${base}-${randomBytes(3).toString("hex")}`;
}
