import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { BSON, ObjectId } from 'mongodb';

import { ConfigError, loadConfig } from '../src/config.js';

class GeneratorError extends Error {}

async function readPassword() {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new GeneratorError('Run this generator in an interactive terminal.');
  }

  const silentOutput = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const prompt = createInterface({ input: stdin, output: silentOutput, terminal: true });
  const cancelled = new AbortController();
  prompt.once('SIGINT', () => cancelled.abort());
  prompt.once('close', () => cancelled.abort());

  async function ask(label) {
    stdout.write(label);
    try {
      return await prompt.question('', { signal: cancelled.signal });
    } finally {
      stdout.write('\n');
    }
  }

  try {
    const password = await ask('Owner password (hidden): ');
    if (password.length < 12 || password.length > 128 || !password.trim() || /[\r\n]/.test(password)) {
      throw new GeneratorError('Use a single-line password of 12–128 characters.');
    }
    if (password !== await ask('Confirm owner password (hidden): ')) {
      throw new GeneratorError('The passwords did not match.');
    }
    return password;
  } finally {
    prompt.close();
  }
}

export async function buildOwnerDocuments(email, password) {
  const userId = new ObjectId();
  const now = new Date();
  const passwordHash = await hashPassword(password);
  if (!(await verifyPassword({ hash: passwordHash, password }))) {
    throw new GeneratorError('Better Auth could not verify the generated hash.');
  }

  // Match the BSON written by the existing offline provisioning command.
  const user = {
    _id: userId,
    name: 'Brinto',
    email,
    emailVerified: true,
    role: 'user',
    banned: false,
    createdAt: now,
    updatedAt: now,
  };
  const account = {
    _id: new ObjectId(),
    accountId: userId.toHexString(),
    providerId: 'credential',
    userId,
    password: passwordHash,
    createdAt: now,
    updatedAt: now,
  };
  return { user, account };
}

async function saveDocuments({ user, account }) {
  const directory = await mkdtemp(join(homedir(), 'brinto-owner-'));
  const userPath = join(directory, 'super-admin-user.json');
  const accountPath = join(directory, 'super-admin-account.json');
  const encode = (document) => BSON.EJSON.stringify(document, null, 2) + '\n';
  const options = { flag: 'wx', mode: 0o600 };

  try {
    await writeFile(userPath, encode(user), options);
    await writeFile(accountPath, encode(account), options);
  } catch (error) {
    await Promise.allSettled([unlink(userPath), unlink(accountPath)]);
    await rmdir(directory).catch(() => {});
    throw error;
  }

  console.log('Generated both owner documents in:');
  console.log(directory);
}

async function main() {
  const { dbName, ownerEmail } = loadConfig();
  if (dbName !== 'brinto-portfolio') {
    throw new GeneratorError('The configured database must be brinto-portfolio.');
  }

  await saveDocuments(await buildOwnerDocuments(ownerEmail, await readPassword()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    if (error instanceof GeneratorError || error instanceof ConfigError) {
      console.error(error.message);
    } else if (error?.name === 'AbortError') {
      console.error('Password entry cancelled.');
    } else {
      console.error('Could not generate the owner documents.');
    }
    process.exitCode = 1;
  }
}
