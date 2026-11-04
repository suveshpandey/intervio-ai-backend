// Per-request identity, attached by middleware.
declare global {
  namespace Express {
    interface Request {
      /** The authenticated user (set by requireAuth). */
      userId?: string;
      /** This browser's id, from its cookie (set by identifyDevice). */
      deviceId?: string;
      /** This device's fingerprint hash, if the client sent a valid one (identifyDevice). */
      fingerprint?: string;
    }
  }
}

export {};
