import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { badRequest, notFound } from '@/common/errors';
import { param } from '@/common/http';
import { putObject, deleteObject } from '@/storage/s3';
import { ACCEPTED_MIME } from '@/modules/resume/text-extract';
import { resumeRepository } from '@/modules/resume/resume.repository';
import { claimRepository } from '@/modules/intelligence/claim.repository';
import { enqueueParse } from '@/jobs/queue';

function publicResume(r: {
  id: string;
  fileName: string;
  parseStatus: string;
  parseError: string | null;
  extracted: unknown;
  createdAt: Date;
}) {
  return {
    id: r.id,
    fileName: r.fileName,
    parseStatus: r.parseStatus,
    parseError: r.parseError,
    extracted: r.extracted,
    createdAt: r.createdAt,
  };
}

export const resumeController = {
  async upload(req: Request, res: Response) {
    const userId = req.userId!;
    const file = req.file;
    if (!file) throw badRequest('No file uploaded', 'no_file');

    const type = ACCEPTED_MIME[file.mimetype as keyof typeof ACCEPTED_MIME];
    if (!type) throw badRequest('Only PDF and DOCX files are supported', 'bad_type');

    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    const key = `resumes/${userId}/${nanoid()}.${type}`;
    await putObject(key, file.buffer, file.mimetype);

    const resume = await resumeRepository.create({
      userId,
      fileUrl: key,
      fileName: file.originalname,
      fileHash,
    });
    await enqueueParse(resume.id);

    res.status(201).json({ resume: publicResume(resume) });
  },

  async list(req: Request, res: Response) {
    const resumes = await resumeRepository.listByUser(req.userId!);
    res.json({ resumes: resumes.map(publicResume) });
  },

  async detail(req: Request, res: Response) {
    const resume = await resumeRepository.findById(param(req, 'id'), req.userId!);
    if (!resume) throw notFound('Resume not found');
    const claims = await claimRepository.listByResume(resume.id);
    res.json({ resume: publicResume(resume), claims });
  },

  async remove(req: Request, res: Response) {
    const resume = await resumeRepository.findById(param(req, 'id'), req.userId!);
    if (!resume) throw notFound('Resume not found');
    await resumeRepository.softDelete(resume.id, req.userId!);
    await deleteObject(resume.fileUrl).catch(() => {}); // best-effort storage purge
    res.json({ ok: true });
  },
};
