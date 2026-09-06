/** An error carrying an HTTP status the API layer can translate directly. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (msg: string, code?: string) => new AppError(400, msg, code);
export const unauthorized = (msg = 'Unauthorized', code?: string) => new AppError(401, msg, code);
export const forbidden = (msg = 'Forbidden', code?: string) => new AppError(403, msg, code);
export const notFound = (msg = 'Not found', code?: string) => new AppError(404, msg, code);
export const conflict = (msg: string, code?: string) => new AppError(409, msg, code);
