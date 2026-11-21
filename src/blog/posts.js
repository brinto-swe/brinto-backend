import { createHmac, timingSafeEqual } from 'node:crypto';
import { MongoServerError, ObjectId } from 'mongodb';
import {
  BlogError, categories, derivePostFields, readPost, readStatus, requirePublishable, statuses,
} from './validation.js';

const publicCardFields = [
  'slug', 'title', 'excerpt', 'categories', 'tags', 'minutes', 'featuredImage', 'author', 'publishedAt',
];
const ownerFields = [...publicCardFields, 'seo', 'status', 'visibility', 'sortOrder', 'createdAt', 'updatedAt'];
const project = (fields) => Object.fromEntries(fields.map((field) => [field, 1]));
const publicSort = { sortOrder: 1, publishedAt: -1, _id: -1 };
const ownerSort = { updatedAt: -1, _id: -1 };
const pick = (doc, fields) => Object.fromEntries(fields.map((field) => [field, doc[field]]));

function ownerItem(post, detail = false) {
  return { id: post._id.toHexString(), ...pick(post, ownerFields), ...(detail && { content: post.content }) };
}

function publicMatch(now) {
  return { status: 'published', visibility: 'public', publishedAt: { $lte: now } };
}

function searchMatch(words) {
  if (!words.length) return {};
  return {
    $and: words.map((word) => ({
      searchText: { $regex: word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') },
    })),
  };
}

function invalidCursor() {
  return new BlogError(400, 'INVALID_CURSOR', 'Invalid cursor for these filters');
}

function cursorSignature(key, payload, filters) {
  return createHmac('sha256', key)
    .update('brinto:blog:public-cursor:v1:')
    .update(JSON.stringify([filters.words, filters.category ?? null, filters.limit, payload]))
    .digest();
}

function encodeCursor(doc, filters, key) {
  const payload = Buffer.from(JSON.stringify([doc.sortOrder, doc.publishedAt.toISOString(), doc._id.toHexString()]))
    .toString('base64url');
  return `${payload}.${cursorSignature(key, payload, filters).toString('base64url')}`;
}

function afterCursor(filters, key) {
  if (!filters.cursor) return {};
  const [payload, encodedSignature] = filters.cursor.split('.');
  const signature = Buffer.from(encodedSignature, 'base64url');
  const expected = cursorSignature(key, payload, filters);
  if (signature.length !== expected.length || signature.toString('base64url') !== encodedSignature ||
      !timingSafeEqual(signature, expected)) throw invalidCursor();

  const [sortOrder, date, id] = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const publishedAt = new Date(date);
  const _id = new ObjectId(id);
  return {
    $or: [
      { sortOrder: { $gt: sortOrder } },
      { sortOrder, publishedAt: { $lt: publishedAt } },
      { sortOrder, publishedAt, _id: { $lt: _id } },
    ],
  };
}

const missing = () => new BlogError(404, 'POST_NOT_FOUND', 'Post not found');

export function createPostRepository(collection, cursorKey) {
  async function getOwnerDocument(_id) {
    const doc = await collection.findOne({ _id });
    if (!doc) throw missing();
    return doc;
  }

  async function updateDocument(previous, changes) {
    // Prevent a parallel edit or publication action from applying to a stale version.
    const updatedAt = new Date(Math.max(Date.now(), previous.updatedAt.getTime() + 1));
    const updated = await collection.findOneAndUpdate(
      { _id: previous._id, updatedAt: previous.updatedAt },
      { $set: { ...changes, updatedAt } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new BlogError(409, 'POST_CHANGED', 'The post changed. Reload it and try again.');
    return ownerItem(updated, true);
  }

  return {
    async listPublic(filters) {
      const { category, limit, words } = filters;
      const match = { ...publicMatch(new Date()), ...searchMatch(words) };
      const pageMatch = { ...match, ...(category && { categories: category }), ...afterCursor(filters, cursorKey) };
      const [documents, results] = await Promise.all([
        collection.find(pageMatch, { projection: project([...publicCardFields, 'sortOrder']) })
          .sort(publicSort).limit(limit + 1).toArray(),
        collection.aggregate([
          { $match: match },
          { $project: { _id: 0, categories: 1 } },
          { $facet: {
            all: [{ $count: 'count' }],
            byCategory: [{ $unwind: '$categories' }, { $group: { _id: '$categories', count: { $sum: 1 } } }],
          } },
        ]).next(),
      ]);
      const facets = { all: results?.all[0]?.count ?? 0, ...Object.fromEntries(categories.map((key) => [key, 0])) };
      for (const { _id, count } of results?.byCategory ?? []) {
        if (categories.includes(_id)) facets[_id] = count;
      }
      const page = documents.slice(0, limit);
      return {
        items: page.map((doc) => pick(doc, publicCardFields)),
        total: facets[category ?? 'all'],
        facets,
        nextCursor: documents.length > limit ? encodeCursor(page.at(-1), filters, cursorKey) : null,
      };
    },

    async getPublic(slug) {
      const fields = [...publicCardFields, 'content', 'seo'];
      const doc = await collection.findOne(
        { slug, ...publicMatch(new Date()) },
        { projection: { _id: 0, ...project(fields) } },
      );
      if (!doc) throw missing();
      return pick(doc, fields);
    },

    async listOwner({ category, status, words, page, limit }) {
      const filter = { ...searchMatch(words), ...(category && { categories: category }), ...(status && { status }) };
      const [documents, total, counts] = await Promise.all([
        collection.find(filter, { projection: project(ownerFields) })
          .sort(ownerSort).skip((page - 1) * limit).limit(limit).toArray(),
        collection.countDocuments(filter),
        collection.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray(),
      ]);
      const countsByStatus = Object.fromEntries(statuses.map((key) => [key, 0]));
      for (const { _id, count } of counts) {
        if (statuses.includes(_id)) countsByStatus[_id] = count;
      }
      return { items: documents.map((doc) => ownerItem(doc)), total, page, limit, countsByStatus };
    },

    async getOwner(id) {
      return ownerItem(await getOwnerDocument(id), true);
    },

    async create(body) {
      const post = readPost(body);
      const now = new Date();
      const doc = {
        _id: new ObjectId(),
        ...post,
        ...derivePostFields(post),
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        publishedAt: null,
      };
      try {
        await collection.insertOne(doc);
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000 && error.keyPattern?.slug) {
          throw new BlogError(409, 'SLUG_CONFLICT', 'A post already uses this slug', { slug: 'Choose a different slug.' });
        }
        throw error;
      }
      return ownerItem(doc, true);
    },

    async update(id, body) {
      const previous = await getOwnerDocument(id);
      const post = readPost(body, previous);
      if (previous.status === 'published') requirePublishable(post);
      return updateDocument(previous, { ...post, ...derivePostFields(post) });
    },

    async changeStatus(id, body) {
      const now = new Date();
      const { status, publishedAt } = readStatus(body, now);
      const previous = await getOwnerDocument(id);
      if (status !== 'published') return updateDocument(previous, { status });
      requirePublishable(previous);
      const date = publishedAt ?? previous.publishedAt ?? now;
      if (date > now) throw new BlogError(422, 'INVALID_POST', 'Invalid blog content', {
        publishedAt: 'Choose a publication time at or before the present.',
      });
      return updateDocument(previous, { status, publishedAt: date });
    },

    async delete(id) {
      const result = await collection.deleteOne({ _id: id });
      if (!result.deletedCount) throw missing();
    },
  };
}
