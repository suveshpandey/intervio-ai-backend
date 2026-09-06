import { OAuth2Client } from 'google-auth-library';
import { env, googleOAuthEnabled } from '@/config/env';
import { badRequest, unauthorized } from '@/common/errors';

const client = googleOAuthEnabled
  ? new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI)
  : null;

export interface GoogleProfile {
  email: string;
  name?: string;
  avatarUrl?: string;
}

/** URL to send the browser to for Google consent. `state` guards against CSRF. */
export function getGoogleAuthUrl(state: string): string {
  if (!client) throw badRequest('Google OAuth is not configured', 'google_disabled');
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account',
    scope: ['openid', 'email', 'profile'],
    state,
  });
}

/** Exchange an auth code for the user's verified Google profile. */
export async function exchangeGoogleCode(code: string): Promise<GoogleProfile> {
  if (!client) throw badRequest('Google OAuth is not configured', 'google_disabled');

  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw unauthorized('Google did not return an identity token');

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.email || !payload.email_verified) {
    throw unauthorized('Google account has no verified email');
  }

  return {
    email: payload.email,
    name: payload.name,
    avatarUrl: payload.picture,
  };
}
