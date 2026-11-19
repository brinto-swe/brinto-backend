import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from './src/app.js';
import { createAuth } from './src/auth.js';
import { ConfigError, loadConfig } from './src/config.js';
import { createDatabase } from './src/database.js';
import { reportError } from './src/errors.js';

let database;
let stage = 'validate configuration';

try {
  const config = loadConfig();
  stage = 'connect to MongoDB and prepare application indexes';
  database = createDatabase(config);
  await database.connect();

  stage = 'initialize Better Auth';
  const auth = createAuth(config, database);
  await auth.$context;

  stage = 'start the HTTP listener';
  const server = createServer(createApp({ config, database, auth }));
  server.listen(config.port, config.host);
  await once(server, 'listening');
  console.info(`Brinto API listening on port ${config.port}.`);

  let stopping = false;

  async function shutdown() {
    if (stopping) return;
    stopping = true;

    const deadline = setTimeout(() => {
      reportError('HTTP shutdown timed out');
      process.exitCode = 1;
      server.closeAllConnections();
    }, 10_000).unref();

    try {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    } catch (error) {
      reportError('HTTP shutdown failed', error);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
      try {
        await database.close();
      } catch (error) {
        reportError('MongoDB shutdown failed', error);
        process.exitCode = 1;
      }
    }
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.on('error', (error) => {
    reportError('HTTP server failed', error);
    process.exitCode = 1;
    void shutdown();
  });
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    reportError(`Could not ${stage}`, error);
  }
  process.exitCode = 1;
  try {
    await database?.close();
  } catch (closeError) {
    reportError('MongoDB cleanup failed', closeError);
  }
}
