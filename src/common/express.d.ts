// Attaches the authenticated user id to the request (set by requireAuth).
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export {};
