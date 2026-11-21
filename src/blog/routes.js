import { Router } from 'express';
import { readId, readListQuery, readSlug } from './validation.js';

export function publicPostRoutes(posts) {
  const router = Router();
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/', async (request, response) => {
    response.json(await posts.listPublic(readListQuery(request.query)));
  });
  router.get('/:slug', async (request, response) => {
    response.json({ item: await posts.getPublic(readSlug(request.params.slug)) });
  });
  return router;
}

export function ownerPostRoutes(posts) {
  const router = Router();

  router.get('/', async (request, response) => {
    response.json(await posts.listOwner(readListQuery(request.query, true)));
  });
  router.get('/:id', async (request, response) => {
    response.json({ item: await posts.getOwner(readId(request.params.id)) });
  });
  router.post('/', async (request, response) => {
    response.status(201).json({ item: await posts.create(request.body) });
  });
  router.patch('/:id/status', async (request, response) => {
    response.json({ item: await posts.changeStatus(readId(request.params.id), request.body) });
  });
  router.patch('/:id', async (request, response) => {
    response.json({ item: await posts.update(readId(request.params.id), request.body) });
  });
  router.delete('/:id', async (request, response) => {
    await posts.delete(readId(request.params.id));
    response.status(204).end();
  });
  return router;
}
