import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '@/db/prisma';
import { notFound } from '@/common/errors';
import { parseJd } from '@/modules/intelligence/extraction';

const jdInput = z.object({ rawText: z.string().min(30, 'Paste a fuller job description') });

export const jdController = {
  async create(req: Request, res: Response) {
    const { rawText } = jdInput.parse(req.body);
    const parsed = await parseJd(rawText);

    const jd = await prisma.jobDescription.create({
      data: { userId: req.userId!, rawText, requiredSkills: parsed.required_skills },
    });
    res.status(201).json({ jd });
  },

  async detail(req: Request, res: Response) {
    const jd = await prisma.jobDescription.findFirst({
      where: { id: req.params.id!, userId: req.userId! },
    });
    if (!jd) throw notFound('Job description not found');
    res.json({ jd });
  },
};
