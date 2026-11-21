import express, { Router } from 'express';
import { toNodeHandler } from 'better-auth/node';
import { handleError } from './errors.js';
import { requireOwner } from './owner.js';
import { createPostRepository } from './blog/posts.js';
import { ownerPostRoutes, publicPostRoutes } from './blog/routes.js';
import { ownerMediaRoutes } from './media/images.js';

export function createApp({ config, database, auth, mediaFetch }) {
  const app = express();
  app.disable('x-powered-by');

  app.all(['/api/auth', '/api/auth/*splat'], (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  }, toNodeHandler(auth));

  const json = express.json({ limit: '100kb' });
  app.get('/', (_request, response) => response.send('Hello World!'));

  const api = Router();
  const posts = createPostRepository(database.collections?.posts, config.secret);
  api.get('/health', (_request, response) => response.json({ status: 'ok' }));
  api.get('/ready', async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      await database.ping();
      return response.json({ status: 'ready', database: 'up' });
    } catch {
      return response.status(503).json({ status: 'unavailable', database: 'down' });
    }
  });

  const admin = Router();
  admin.use(requireOwner(auth, config));
  admin.use('/media', ownerMediaRoutes(config, database.collections?.mediaAssets, mediaFetch));
  admin.use(json);
  admin.get('/session', (_request, response) => {
    const { id, email } = response.locals.owner;
    response.json({ owner: { id, email } });
  });
  admin.use('/posts', ownerPostRoutes(posts));
  api.use('/admin', admin);
  api.use(json);
  api.use('/posts', publicPostRoutes(posts));

  app.use('/api', api);
  app.use((_request, response) => response.status(404).json({ error: 'Not found' }));
  app.use(handleError);
  return app;
}
