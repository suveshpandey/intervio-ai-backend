import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '@/common/auth-guard';
import { resumeController } from '@/modules/resume/resume.controller';

// Files are small (resumes); keep them in memory and cap at 5MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

export const resumeRouter = Router();

resumeRouter.use(requireAuth);
resumeRouter.post('/', upload.single('file'), resumeController.upload);
resumeRouter.get('/', resumeController.list);
resumeRouter.get('/:id', resumeController.detail);
resumeRouter.delete('/:id', resumeController.remove);
