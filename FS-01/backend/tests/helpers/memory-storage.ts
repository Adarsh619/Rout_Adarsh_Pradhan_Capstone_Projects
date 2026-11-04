import type { Storage, StoredObject } from "../../src/lib/s3.js";

// Storage that keeps files in a Map, for unit tests that never reach S3.
export function memoryStorage(): Storage & { objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>();
  return {
    objects,
    presignPut: async (key, contentType, size) =>
      `http://storage.test/bucket/${key}?type=${encodeURIComponent(contentType)}&size=${size}`,
    head: async (key) => objects.get(key) ?? null,
    put: async (key, body, contentType) => {
      objects.set(key, { contentType, size: body.byteLength });
    },
    deleteMany: async (keys) => {
      keys.forEach((k) => objects.delete(k));
    },
    publicUrl: (key) => `http://storage.test/bucket/${key}`,
  };
}
