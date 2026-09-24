import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '@/common/auth-guard';
import { resumeController } from '@/modules/resume/resume.controller';
import { rateLimit } from '@/common/rate-limit';

// Files are small (resumes); keep them in memory and cap at 5MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

export const resumeRouter = Router();

resumeRouter.use(requireAuth);
resumeRouter.post(
  '/',
  rateLimit({
    name: 'resume-upload',
    limit: 12,
    windowSec: 60 * 60,
    message: "That's a lot of resumes in one hour. Try again a bit later.",
  }),
  upload.single('file'),
  resumeController.upload,
);
resumeRouter.get('/', resumeController.list);
resumeRouter.get('/:id', resumeController.detail);
resumeRouter.delete('/:id', resumeController.remove);
