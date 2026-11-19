import { admin } from 'better-auth/plugins';
import { createAuth } from '../src/auth.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { createDatabase } from '../src/database.js';
import { reportError } from '../src/errors.js';

async function readPassword() {
  if (process.stdin.isTTY) throw new ConfigError('Pipe the owner password from a masked prompt on standard input.');
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 130) throw new ConfigError('Owner passwords must contain 12–128 characters.');
  }
  const password = input.replace(/\r?\n$/, '');
  if (password.length < 12 || password.length > 128 || !password.trim() || /[\r\n]/.test(password)) {
    throw new ConfigError('Provide a single-line owner password of 12–128 characters.');
  }
  return password;
}

let database;
try {
  const config = loadConfig();
  if (!config.mongoTransactions) {
    throw new ConfigError('Owner provisioning requires a replica set or sharded cluster and MONGODB_TRANSACTIONS=true.');
  }
  const password = await readPassword();
  database = createDatabase(config);
  await database.connect({ prepareIndexes: false });

  // This process never starts a listener and the HTTP server never loads this plugin.
  const auth = createAuth(config, database, [admin()]);
  await auth.api.createUser({
    body: {
      email: config.ownerEmail,
      name: 'Portfolio Owner',
      password,
      data: { emailVerified: true },
    },
  });
  console.info('Owner account created.');
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else if (error?.body?.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') {
    console.error('An account with OWNER_EMAIL already exists.');
  } else {
    reportError('Owner provisioning failed', error);
  }
  process.exitCode = 1;
} finally {
  try {
    await database?.close();
  } catch (error) {
    reportError('MongoDB cleanup failed', error);
    process.exitCode = 1;
  }
}
