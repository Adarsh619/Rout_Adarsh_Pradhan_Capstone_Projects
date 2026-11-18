import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { config } from "../../config.js";
import { inTransaction, prisma } from "../../lib/db.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { queryInt, routeId } from "../../lib/http.js";
import { id, parse } from "../../lib/validate.js";
import { z } from "zod";
import { entity } from "../audit/entities.js";
import { record } from "../audit/service.js";
import { currentUser } from "../auth/middleware.js";
import { hasRole, need, useWorkspace, ws } from "../tenancy/context.js";
import { own, ref, sendPage } from "./common.js";
import { absolute, deleteAttachmentFiles, safeName, saveFile } from "./files.js";
import { attachmentOut } from "./serialize.js";

// Attachments: multipart uploads (field "file") kept on disk; downloads go through this tenant-checked API.

const withUploader = { uploadedBy: true } as const;
const uploadBody = z.object({ issue: id });

// Read the upload into memory, refusing anything over MAX_ATTACHMENT_SIZE (read per request so tests can change it).
function upload(req: Request, res: Response, next: NextFunction) {
  multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_ATTACHMENT_SIZE, files: 1 } }).single("file")(req, res, next);
}

export function attachmentsRouter(): Router {
  const r = Router();
  r.use(useWorkspace);
  const find = (req: Request) =>
    own(prisma.attachment.findFirst({ where: { id: routeId(req), workspaceId: ws(req).id }, include: withUploader }));

  r.get("/", (req, res) => {
    const issueId = queryInt(req, "issue");
    return sendPage(req, res, prisma.attachment, { workspaceId: ws(req).id, ...(issueId !== undefined && { issueId }) },
      [{ createdAt: "desc" }, { id: "desc" }], attachmentOut, withUploader);
  });
  r.get("/:id/", async (req, res) => {
    res.json(attachmentOut(await find(req)));
  });

  r.post("/", (req, _res, next) => (need(req, "member"), next()), upload, async (req, res) => {
    const data = parse(uploadBody, req.body);
    if (!req.file) throw badRequest({ file: "No file was submitted." });
    const issue = await ref(prisma, "issue", data.issue, ws(req).id, "issue");
    const project = await prisma.project.findUniqueOrThrow({ where: { id: issue.projectId }, select: { key: true } });
    const stored = await saveFile(ws(req).id, issue.id, req.file.originalname, req.file.buffer);
    try {
      const att = await inTransaction(async (unit) => {
        const a = await unit.tx.attachment.create({
          data: {
            workspaceId: ws(req).id, issueId: issue.id, file: stored, filename: safeName(req.file!.originalname),
            size: req.file!.size, uploadedById: currentUser(req).id,
          },
          include: withUploader,
        });
        await record(unit, req, "attachment.created", entity.attachment(a), { issue: `${project.key}-${issue.number}`, filename: a.filename });
        return a;
      });
      res.status(201).json(attachmentOut(att));
    } catch (err) {
      await deleteAttachmentFiles([stored]);
      throw err;
    }
  });

  r.delete("/:id/", async (req, res) => {
    need(req, "member");
    const a = await find(req);
    if (a.uploadedById !== currentUser(req).id && !hasRole(req.membership, "admin")) {
      throw forbidden("Only the uploader or an admin can delete this attachment.");
    }
    await inTransaction(async (unit) => {
      await record(unit, req, "attachment.deleted", entity.attachment(a));
      await unit.tx.attachment.delete({ where: { id: a.id } });
    });
    // The file goes once the delete has committed.
    await deleteAttachmentFiles([a.file]);
    res.status(204).end();
  });

  r.get("/:id/download/", async (req, res) => {
    const a = await find(req); // tenant-scoped lookup
    const path = absolute(a.file);
    const info = await stat(path).catch(() => null);
    if (!info) throw notFound();
    res.attachment(a.filename);
    res.setHeader("Content-Length", String(info.size));
    createReadStream(path).pipe(res);
  });
  return r;
}
