import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { reportError } from './errors.js';

const requireSessionRevocation = {
  id: 'require-session-revocation',
  middlewares: [{
    path: '/sign-out',
    middleware: createAuthMiddleware(async (ctx) => {
      if (ctx.request?.method !== 'POST') return;
      const { authCookies, secret, internalAdapter } = ctx.context;
      const token = await ctx.getSignedCookie(authCookies.sessionToken.name, secret);
      if (!token) return;

      // Better Auth clears the cookie even when its own session deletion fails.
      // Require revocation first so a failed request retains the cookie for retry.
      try {
        await internalAdapter.deleteSession(token);
      } catch (error) {
        reportError('Could not revoke session on sign-out', error);
        throw APIError.fromStatus('SERVICE_UNAVAILABLE', { message: 'Could not revoke session' });
      }
    }),
  }],
};

export function createAuth(config, { db, client }, plugins = []) {
  return betterAuth({
    baseURL: config.publicOrigin,
    basePath: '/api/auth',
    secret: config.secret,
    trustedOrigins: [config.publicOrigin],
    database: mongodbAdapter(db, { client, transaction: config.mongoTransactions }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
    },
    user: { changeEmail: { enabled: false } },
    session: { cookieCache: { enabled: false } },
    advanced: {
      useSecureCookies: config.publicOrigin.startsWith('https:'),
      // The rewrite does not establish a trusted client IP header.
      ipAddress: { ipAddressHeaders: [] },
    },
    rateLimit: { enabled: true },
    telemetry: { enabled: false },
    logger: {
      level: 'warn',
      log(level) {
        reportError(`Better Auth logged a ${level === 'error' ? 'failure' : 'warning'}`);
      },
    },
    plugins: [requireSessionRevocation, ...plugins],
  });
}
