import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { logger } from "../../lib/logger.js";

// Attachment files live under MEDIA_ROOT (a Docker volume) and are never served directly: downloads go through the
// tenant-checked API. Paths are workspaces/<ws>/issues/<issue>/<name>, as in v1.

// Keep the uploaded name readable but safe as a file name (no folders, no control characters).
export function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
  const base = path.basename(name.replace(/\\/g, "/")).replace(/[\x00-\x1f<>:"|?*]/g, "_").trim();
  return (base || "file").slice(0, 200);
}

export const absolute = (relative: string): string => {
  const root = path.resolve(config.MEDIA_ROOT);
  const full = path.resolve(root, relative);
  if (!full.startsWith(root + path.sep)) throw new Error("Attachment path escapes MEDIA_ROOT");
  return full;
};

// Store the bytes and return the stored path (relative to MEDIA_ROOT). Adds a suffix if the name is taken.
export async function saveFile(workspaceId: number, issueId: number, name: string, data: Buffer): Promise<string> {
  const dir = `workspaces/${workspaceId}/issues/${issueId}`;
  await mkdir(absolute(dir), { recursive: true });
  const clean = safeName(name);
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = `${dir}/${i ? `${stem}_${i}${ext}` : clean}`;
    try {
      await writeFile(absolute(candidate), data, { flag: "wx" });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || i > 1000) throw err;
    }
  }
}

// Remove stored files after their rows are gone (never before: a rolled-back delete must keep its file).
export async function deleteAttachmentFiles(files: string[]): Promise<void> {
  for (const f of files) {
    await rm(absolute(f), { force: true }).catch((err) => logger.warn({ err, file: f }, "could not delete attachment"));
  }
}
