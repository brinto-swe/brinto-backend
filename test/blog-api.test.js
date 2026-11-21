import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { MongoServerError, ObjectId } from 'mongodb';
import { createApp } from '../src/app.js';

function comparable(value) {
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.getTime();
  return value;
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$and') return expected.every((part) => matches(document, part));
    if (key === '$or') return expected.some((part) => matches(document, part));
    const actual = comparable(document[key]);
    if (Array.isArray(actual)) return actual.includes(expected);
    if (expected && typeof expected === 'object' && expected.constructor === Object) {
      return Object.entries(expected).every(([operator, value]) => {
        if (operator === '$regex') return typeof actual === 'string' && new RegExp(value).test(actual);
        if (operator === '$lte') return document[key] instanceof Date && actual <= comparable(value);
        if (operator === '$lt') return actual < comparable(value);
        if (operator === '$gt') return actual > comparable(value);
        assert.fail(`Unsupported fixture query operator ${operator}`);
      });
    }
    return actual === comparable(expected);
  });
}

function group(rows, key) {
  const counts = new Map();
  for (const row of rows) counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
  return [...counts].map(([_id, count]) => ({ _id, count }));
}

function projected(doc, projection) {
  if (!projection) return doc;
  const fields = Object.keys(projection).filter((key) => projection[key]);
  if (projection._id !== 0 && !fields.includes('_id')) fields.push('_id');
  return Object.fromEntries(fields.map((key) => [key, doc[key]]));
}

function memoryCollection() {
  const docs = [];
  function find(filter, { projection } = {}) {
    const rows = docs.filter((row) => matches(row, filter));
    let offset = 0;
    let size = Infinity;
    return {
      sort(order) {
        rows.sort((a, b) => {
          for (const [key, direction] of Object.entries(order)) {
            const left = comparable(a[key]);
            const right = comparable(b[key]);
            if (left !== right) return (left < right ? -1 : 1) * direction;
          }
          return 0;
        });
        return this;
      },
      skip(count) { offset = count; return this; },
      limit(count) { size = count; return this; },
      async toArray() { return rows.slice(offset, offset + size).map((row) => projected(row, projection)); },
    };
  }
  return {
    docs,
    find,
    async findOne(filter, options) { return (await find(filter, options).limit(1).toArray())[0] ?? null; },
    async countDocuments(filter) { return docs.filter((row) => matches(row, filter)).length; },
    aggregate(pipeline) {
      if (pipeline[0].$group) {
        assert.equal(pipeline[0].$group._id, '$status');
        return { async toArray() { return group(docs, 'status'); } };
      }
      assert.ok(pipeline[2].$facet);
      const rows = docs.filter((row) => matches(row, pipeline[0].$match));
      return { async next() {
        return {
          all: rows.length ? [{ count: rows.length }] : [],
          byCategory: group(rows.flatMap((row) => row.categories.map((categories) => ({ categories }))), 'categories'),
        };
      } };
    },
    async insertOne(doc) {
      if (docs.some((item) => item.slug === doc.slug)) {
        throw new MongoServerError({ code: 11000, keyPattern: { slug: 1 } });
      }
      docs.push(doc);
    },
    async findOneAndUpdate(filter, { $set }, options) {
      assert.equal(options.returnDocument, 'after');
      const index = docs.findIndex((row) => matches(row, filter));
      if (index === -1) return null;
      docs[index] = { ...docs[index], ...$set };
      return docs[index];
    },
    async deleteOne(filter) {
      const index = docs.findIndex((row) => matches(row, filter));
      return { deletedCount: index === -1 ? 0 : docs.splice(index, 1).length };
    },
  };
}

const localized = (en, bn) => ({ en, bn });
const fixture = (slug) => ({
  slug,
  title: localized('Neural networks', 'কৃষি প্রযুক্তি'),
  excerpt: localized('Overview', 'সারাংশ'),
  author: localized('Brinto', 'ব্রিন্টো'),
  categories: ['ai', 'research'],
  tags: localized(['C++'], ['দৃষ্টান্ত']),
  content: localized(
    [
      { kind: 'heading', level: 2, text: 'Introduction' },
      { kind: 'paragraph', text: ['A ', { kind: 'strong', text: 'model' }, { kind: 'link', text: 'source', href: 'https://example.test/docs' }] },
      { kind: 'list', ordered: true, items: [[{ kind: 'code', text: 'item' }]] },
      { kind: 'code', language: 'javascript', code: 'const x = 1;', caption: 'Example' },
      { kind: 'image', src: '/blog/desk.webp', width: 960, height: 500, alt: 'Desk', caption: 'Working area' },
    ],
    [{ kind: 'quote', text: [{ kind: 'emphasis', text: 'পরীক্ষা' }] }],
  ),
  featuredImage: { kind: 'sprite', tile: 0 },
});

test('Blog API against an isolated collection fixture', async (t) => {
  const collection = memoryCollection();
  const config = { ownerEmail: 'owner@example.test', publicOrigin: 'http://localhost:3000', secret: 'synthetic-blog-fixture-only' };
  const auth = {
    handler: async () => new Response(null, { status: 404 }),
    api: {
      async getSession({ headers }) {
        const identity = headers.get('cookie');
        if (!identity) return null;
        return {
          session: { expiresAt: new Date('2099-01-01') },
          user: { email: identity === 'fixture=owner' ? config.ownerEmail : 'other@example.test', emailVerified: true },
        };
      },
    },
  };
  const server = createApp({ auth, config, database: { collections: { posts: collection } } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function call(path, { method = 'GET', body, identity = 'owner', raw = false, requestOrigin = config.publicOrigin } = {}) {
    const headers = { Origin: requestOrigin };
    if (identity) headers.Cookie = `fixture=${identity}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(origin + '/api' + path, {
      method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    if (path.startsWith('/admin/')) assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  }

  const create = (body) => call('/admin/posts', { method: 'POST', body });
  const change = (id, body) => call(`/admin/posts/${id}/status`, { method: 'PATCH', body });
  const update = (id, body) => call(`/admin/posts/${id}`, { method: 'PATCH', body });

  await t.test('existing owner middleware rejects anonymous, non-owner and foreign origins', async () => {
    assert.equal((await call('/admin/posts', { identity: null })).status, 401);
    assert.equal((await call('/admin/posts', { identity: 'nonowner' })).status, 403);
    assert.equal((await call('/admin/posts', { method: 'POST', body: fixture('denied'), requestOrigin: 'https://other.example.test' })).status, 403);
  });

  const created = new Map();
  await t.test('owner CRUD, duplicate slugs and status changes', async () => {
    for (const slug of ['article-a', 'article-b', 'other-category', 'draft', 'archived', 'hidden', 'future']) {
      const body = fixture(slug);
      if (slug === 'other-category') body.categories = ['ml'];
      if (slug === 'hidden') body.visibility = 'hidden';
      const { status, data } = await create(body);
      assert.equal(status, 201);
      assert.equal(data.item.status, 'draft');
      assert.equal(data.item.publishedAt, null);
      created.set(slug, data.item);
      if (slug !== 'draft') assert.equal((await change(data.item.id, { status: 'published', publishedAt: '2026-01-01' })).status, 200);
    }
    const duplicate = await create(fixture('article-a'));
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'SLUG_CONFLICT');
    assert.equal((await change(created.get('archived').id, { status: 'archived' })).status, 200);
    collection.docs.find((row) => row.slug === 'future').publishedAt = new Date('2099-01-01');
    const id = created.get('article-a').id;
    assert.equal((await update(id, { slug: 'cannot-change' })).status, 422);
    const { data } = await update(id, { title: { en: 'Neural update' } });
    assert.equal(data.item.title.bn, fixture('unused').title.bn);
    assert.equal(data.item.slug, 'article-a');
    const detail = await call(`/admin/posts/${id}`);
    assert.equal(detail.data.item.title.en, 'Neural update');
    assert.deepEqual(detail.data.item.content, fixture('unused').content);
    const ownerList = await call('/admin/posts?status=draft&page=1&limit=1');
    assert.equal(ownerList.data.total, 1);
    assert.deepEqual(ownerList.data.countsByStatus, { draft: 1, archived: 1, published: 5 });
    const removable = await create({ slug: 'temporary-draft' });
    assert.equal((await call(`/admin/posts/${removable.data.item.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await call(`/admin/posts/${removable.data.item.id}`)).status, 404);
  });

  await t.test('both public endpoints filter ineligible records and redact internal fields', async () => {
    const result = await call('/posts', { identity: null });
    assert.deepEqual(new Set(result.data.items.map(({ slug }) => slug)), new Set(['article-a', 'article-b', 'other-category']));
    for (const item of result.data.items) {
      for (const key of ['content', 'status', 'visibility', 'searchText', '_id', 'createdAt', 'updatedAt']) assert.ok(!(key in item));
    }
    for (const slug of ['draft', 'archived', 'hidden', 'future', 'missing']) {
      assert.equal((await call(`/posts/${slug}`, { identity: null })).status, 404);
    }
    const detail = await call('/posts/article-a', { identity: null });
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.data.item.content, fixture('unused').content);
    assert.ok(!('searchText' in detail.data.item) && !('_id' in detail.data.item));
  });

  await t.test('literal bilingual search, stable cursors and category facets', async () => {
    const query = new URLSearchParams({ q: 'NEURAL কৃষি C++', category: 'ai', limit: '1' });
    const first = await call(`/posts?${query}`);
    assert.equal(first.data.total, 2);
    assert.equal(first.data.facets.all, 3);
    assert.equal(first.data.facets.ml, 1);
    assert.equal(first.data.facets.research, 2);
    assert.equal(first.data.items[0].slug, 'article-b');
    assert.ok(first.data.nextCursor);
    query.set('cursor', first.data.nextCursor);
    const second = await call(`/posts?${query}`);
    assert.equal(second.data.items[0].slug, 'article-a');
    assert.equal(second.data.nextCursor, null);
    query.set('category', 'ml');
    assert.equal((await call(`/posts?${query}`)).data.code, 'INVALID_CURSOR');
    query.set('category', 'ai');
    query.set('cursor', first.data.nextCursor.replace(/.$/, (c) => c === 'A' ? 'B' : 'A'));
    assert.equal((await call(`/posts?${query}`)).status, 400);
    assert.equal((await call('/posts?q=%2E%2A')).data.total, 0);
    assert.equal((await call('/posts?q=Neural%20absent')).data.total, 0);
  });

  await t.test('validation rejects bad content, publication, URLs, categories and oversized payloads', async () => {
    assert.equal((await create({ slug: 'bad-block', content: { en: [{ kind: 'html' }] } })).status, 422);
    assert.equal((await create({ slug: 'bad-inline', content: { en: [{ kind: 'paragraph', text: [{ kind: 'link', text: 'foo', href: 'javascript:alert(1)' }] }] } })).status, 422);
    assert.equal((await create({ slug: 'bad-url', featuredImage: { kind: 'image', src: '//external.example.test/x', width: 1, height: 1, alt: localized('', '') } })).status, 422);
    assert.equal((await create({ slug: 'bad-category', categories: ['missing'] })).status, 422);
    assert.equal((await call('/posts?category=missing')).status, 400);
    assert.equal((await call('/admin/posts/not-an-object-id')).status, 400);
    const draft = await create({ slug: 'incomplete' });
    assert.equal((await change(draft.data.item.id, { status: 'published' })).status, 422);
    assert.equal((await change(created.get('article-a').id, { status: 'published', publishedAt: '2099-01-01' })).status, 422);
    assert.equal((await change(created.get('article-a').id, { status: 'archived', publishedAt: '2026-01-01' })).status, 422);
    assert.equal((await update(created.get('article-a').id, { title: { bn: '' } })).status, 422);
    const malformed = await call('/admin/posts', { method: 'POST', body: '{', raw: true });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.data.code, 'INVALID_JSON');
    const tooLarge = await create({ slug: 'oversized', title: { en: 'a'.repeat(102400) } });
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.data.code, 'PAYLOAD_TOO_LARGE');
  });

  await t.test('default public and owner page sizes are six and five', async () => {
    for (const slug of ['page-extra-1', 'page-extra-2', 'page-extra-3', 'page-extra-4']) {
      const added = await create(fixture(slug));
      assert.equal(added.status, 201);
      assert.equal((await change(added.data.item.id, { status: 'published' })).status, 200);
    }
    const list = await call('/posts');
    assert.equal(list.data.items.length, 6);
    assert.ok(list.data.nextCursor);
    const ownerList = await call('/admin/posts?page=2');
    assert.equal(ownerList.data.limit, 5);
    assert.equal(ownerList.data.items.length, 5);
  });

  await t.test('rich blocks and every combination of marks survive create, update and published detail', async () => {
    const marks = ['bold', 'italic', 'underline', 'code'];
    const combinations = Array.from({ length: 16 }, (_, index) => ({
      kind: 'span', text: `Combination ${index}`, marks: marks.filter((_, bit) => index & (1 << bit)),
      color: ['blue', 'teal', 'purple', 'red'][index % 4],
      href: ['https://example.test/path', '/blogs?view=compact', '#example'][index % 3],
    }));
    const body = fixture('rich-round-trip');
    const nested = {
      kind: 'list', ordered: true,
      items: [['Legacy sibling'], {
        text: [combinations[15]],
        children: [
          { kind: 'list', ordered: false, items: [['Nested keyword', { kind: 'code', text: 'x()' }]] },
          { kind: 'list', ordered: true, items: [[combinations[7]]] },
        ],
      }],
    };
    body.content.en.push(
      { kind: 'heading', level: 3, text: [combinations[3]] },
      { kind: 'paragraph', text: ['plain ', { kind: 'emphasis', text: 'legacy' }, ...combinations] },
      nested,
    );
    const inserted = await create(body);
    assert.equal(inserted.status, 201);
    assert.deepEqual(inserted.data.item.content, body.content);
    const { id } = inserted.data.item;
    body.content.bn.push({ kind: 'quote', text: [{ ...combinations[15], text: 'বাংলা লেখা' }] });
    const edited = await update(id, { content: { bn: body.content.bn } });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.data.item.content, body.content);
    assert.deepEqual(collection.docs.find((row) => row.slug === body.slug).content, body.content);
    assert.equal((await change(id, { status: 'published' })).status, 200);
    assert.deepEqual((await call('/posts/rich-round-trip', { identity: null })).data.item.content, body.content);
    assert.equal((await call('/posts?q=Nested%20keyword', { identity: null })).data.total, 1);
    assert.equal((await call('/posts?q=বাংলা', { identity: null })).data.total, 1);
  });

  await t.test('rich validation rejects arbitrary colors, marks, unsafe links and excessive nesting', async () => {
    const valid = { kind: 'span', text: 'example' };
    const invalid = [
      { color: '#123456' }, { color: 'Blue' }, { color: 'constructor' }, { marks: ['strike'] },
      { marks: ['bold', 'bold'] }, { marks: 'italic' }, { style: { color: 'red' } },
      { text: ' ', href: '/valid' },
      ...['javascript:alert(1)', 'data:text/html,test', 'http://example.test', '//example.test',
        '/\\example.test', 'https:///example.test', 'https://user@example.test', '/line\nbreak', '#bad anchor',
      ].map((href) => ({ href })),
    ];
    for (const override of invalid) {
      const result = await create({ slug: 'invalid-span',
        content: { en: [{ kind: 'paragraph', text: [{ ...valid, ...override }] }] } });
      assert.equal(result.status, 422, JSON.stringify(override));
      assert.match(Object.keys(result.data.fields)[0], /^content\.en\.0\.text\.0/);
    }
    let list = { kind: 'list', ordered: false, items: [['Leaf']] };
    for (let i = 0; i < 3; i++) {
      list = { kind: 'list', ordered: true, items: [{ text: ['Ancestor'], children: [list] }] };
    }
    assert.equal((await create({ slug: 'four-levels', content: { en: [list] } })).status, 201);
    const overDepth = { kind: 'list', ordered: false, items: [{ text: ['One too many'], children: [list] }] };
    assert.equal((await create({ slug: 'five-levels', content: { en: [overDepth] } })).status, 422);
  });
});
