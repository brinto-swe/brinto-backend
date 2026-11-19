import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { betterAuth } from 'better-auth';
import { reportError } from './errors.js';

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
    plugins,
  });
}
