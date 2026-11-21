import dotenv from 'dotenv';

export class ConfigError extends Error {}

export function loadConfig() {
  dotenv.config({ quiet: true });
  const env = process.env;
  const production = env.NODE_ENV === 'production';
  const mongoUri = env.MONGODB_URI?.trim();
  const dbName = env.DB_NAME?.trim();
  const secret = env.BETTER_AUTH_SECRET;
  const ownerEmail = env.OWNER_EMAIL?.trim().toLowerCase();
  const port = Number(env.PORT ?? 5000);
  const host = env.HOST?.trim() || '127.0.0.1';
  const transactions = env.MONGODB_TRANSACTIONS ?? 'true';
  const imgBBKey = env.IMGBB_API_KEY?.trim();
  const imageUploadMaxBytes = Number(env.MEDIA_IMAGE_MAX_BYTES ?? 5 * 1024 * 1024);
  const invalid = [];

  if (!/^mongodb(?:\+srv)?:\/\/[^\s]+$/.test(mongoUri ?? '')) invalid.push('MONGODB_URI');
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(dbName ?? '')) invalid.push('DB_NAME');
  if (!secret || secret.trim().length < 32) invalid.push('BETTER_AUTH_SECRET (at least 32 characters)');
  if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) invalid.push('OWNER_EMAIL');
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid.push('PORT');
  if (!['true', 'false'].includes(transactions)) invalid.push('MONGODB_TRANSACTIONS');
  if (!Number.isInteger(imageUploadMaxBytes) || imageUploadMaxBytes < 1 || imageUploadMaxBytes > 8 * 1024 * 1024) {
    invalid.push('MEDIA_IMAGE_MAX_BYTES (1 to 8388608)');
  }

  let publicOrigin;
  try {
    const url = new URL(env.BETTER_AUTH_URL ?? '');
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        !['https:', ...(production ? [] : ['http:'])].includes(url.protocol)) {
      throw new Error();
    }
    publicOrigin = url.origin;
  } catch {
    invalid.push(production ? 'BETTER_AUTH_URL (HTTPS origin)' : 'BETTER_AUTH_URL (HTTP or HTTPS origin)');
  }

  if (invalid.length) {
    throw new ConfigError(`Missing or invalid environment configuration: ${invalid.join(', ')}.`);
  }

  return {
    mongoUri, dbName, secret, ownerEmail, port, host, publicOrigin,
    mongoTransactions: transactions === 'true', imgBBKey, imageUploadMaxBytes,
  };
}
