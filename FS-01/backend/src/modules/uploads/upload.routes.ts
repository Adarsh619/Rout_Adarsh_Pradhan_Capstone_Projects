import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { hit } from "../../lib/rate-limit.js";
import { requireRole } from "../../middleware/auth.js";
import { AppError } from "../../middleware/errors.js";
import { validateBody } from "../../middleware/validate.js";
import type { RouteContext } from "../context.js";
import { loadOwnStore } from "../vendors/vendor-access.js";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, UPLOAD_PURPOSES, UPLOAD_URL_TTL_SECONDS, type ImageType } from "./upload-rules.js";

const presignSchema = z.object({
  purpose: z.enum(Object.keys(UPLOAD_PURPOSES) as [keyof typeof UPLOAD_PURPOSES]),
  contentType: z.enum(Object.keys(IMAGE_TYPES) as [ImageType], { error: "Photos must be JPEG, PNG or WebP" }),
  size: z.number().int().min(1, "The file is empty").max(MAX_IMAGE_BYTES, "Photos must be 5 MB or smaller"),
});

const PRESIGNS_PER_USER = { limit: 120, window: 15 * 60 };

// The browser asks for a one-file upload link, PUTs the file straight to S3, then sends the key with the product.
// The API never handles the file bytes.
export function uploadRouter(ctx: RouteContext): Router {
  const router = Router();

  router.post(
    "/uploads/presign",
    ctx.signedIn,
    requireRole("vendor"),
    validateBody(presignSchema),
    async (req, _res, next) => {
      const r = await hit(ctx.redis, `presign:${req.auth!.id}`, PRESIGNS_PER_USER.limit, PRESIGNS_PER_USER.window);
      if (!r.allowed) {
        throw new AppError(429, "rate_limited", "Too many uploads. Please wait and try again.", { retryAfterSeconds: r.retryAfterSeconds });
      }
      next();
    },
    // A store logo can be added while the application waits; product photos need an approved store.
    (req, res, next) => loadOwnStore({ approved: (req.body as z.infer<typeof presignSchema>).purpose === "product-image" })(req, res, next),
    async (req, res) => {
      const { purpose, contentType, size } = req.body as z.infer<typeof presignSchema>;
      const key = `${UPLOAD_PURPOSES[purpose](req.vendor!.id as string)}${randomUUID()}.${IMAGE_TYPES[contentType]}`;
      const uploadUrl = await ctx.storage.presignPut(key, contentType, size, UPLOAD_URL_TTL_SECONDS);
      res.status(201).json({
        key,
        uploadUrl,
        method: "PUT",
        // The browser must send exactly this header; it's part of the signature.
        headers: { "Content-Type": contentType },
        url: ctx.storage.publicUrl(key),
        expiresIn: UPLOAD_URL_TTL_SECONDS,
      });
    },
  );

  return router;
}
