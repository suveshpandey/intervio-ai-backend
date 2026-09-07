import mammoth from 'mammoth';
import { extractText as extractPdfText, getDocumentProxy } from 'unpdf';
import { badRequest } from '@/common/errors';

export const ACCEPTED_MIME = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
} as const;

export type ResumeFileType = (typeof ACCEPTED_MIME)[keyof typeof ACCEPTED_MIME];

/** Extract plain text from a resume file buffer. */
export async function extractResumeText(buffer: Buffer, type: ResumeFileType): Promise<string> {
  const text = type === 'pdf' ? await fromPdf(buffer) : await fromDocx(buffer);
  const cleaned = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length < 50) {
    throw badRequest('Could not read enough text from this file (is it a scanned image?)', 'empty_resume');
  }
  return cleaned;
}

async function fromPdf(buffer: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractPdfText(pdf, { mergePages: true });
  return text;
}

async function fromDocx(buffer: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}
