import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { loadBundledArticles, planBlogSeed, prepareSeedPosts } from '../scripts/seed-blog.js';
import { derivePostFields } from '../src/blog/validation.js';

const source = await loadBundledArticles();
const now = new Date('2026-11-21T12:00:00Z');

test('prepares exactly ten original bilingual articles without changing source fields', () => {
  const posts = prepareSeedPosts(source, now);
  assert.equal(posts.length, 10);
  assert.equal(new Set(posts.map(({ _id }) => _id.toHexString())).size, posts.length);
  assert.deepEqual(posts, prepareSeedPosts(source, now));
  for (const [index, doc] of posts.entries()) {
    const article = source.articles[index];
    assert.ok(doc._id instanceof ObjectId);
    assert.equal(doc.slug, article.id);
    assert.equal(doc.publishedAt.toISOString(), article.date + 'T00:00:00.000Z');
    assert.equal(doc.status, 'published');
    assert.equal(doc.visibility, 'public');
    assert.deepEqual(doc.author, source.author);
    for (const key of ['title', 'excerpt', 'tags', 'categories', 'content', 'minutes']) {
      assert.deepEqual(doc[key], article[key], `${article.id}: ${key}`);
    }
    assert.deepEqual(doc.featuredImage, { kind: 'sprite', tile: article.cover });
    assert.equal(doc.searchText, derivePostFields(doc).searchText);
  }
  assert.throws(() => prepareSeedPosts({ ...source, articles: [...source.articles.slice(0, 9), source.articles[0]] }, now), /unique/);
  assert.throws(() => prepareSeedPosts(source, new Date('2026-01-01')), /publishedAt/);
});

test('keeps combined marks, all four palette keys and nested blocks in both languages', () => {
  const fixture = structuredClone(source);
  const spans = ['blue', 'teal', 'purple', 'red'].map((color) => ({
    kind: 'span', text: 'Linked code', color, href: '#source', marks: ['italic', 'bold', 'underline', 'code'],
  }));
  for (const locale of ['en', 'bn']) {
    fixture.articles[0].content[locale].push(
      { kind: 'list', ordered: true, items: [{
        text: ['Parent'],
        children: [{ kind: 'list', ordered: false, items: [spans] }],
      }] },
      { kind: 'code', language: 'js', code: 'x()', caption: 'Code caption' },
      { kind: 'image', src: '/blog/desk.webp', width: 960, height: 492, alt: 'Desk', caption: 'Image caption' },
    );
  }
  const [post] = prepareSeedPosts(fixture, now);
  assert.deepEqual(post.content, fixture.articles[0].content);
  assert.match(post.searchText, /linked code/);
});

test('dry run reports missing, equivalent, edited, duplicate and reserved-ID conflicts using reads only', async () => {
  const posts = prepareSeedPosts(source, now);
  const records = [
    { ...posts[0], _id: new ObjectId(), createdAt: now, updatedAt: now },
    { ...posts[1], title: { ...posts[1].title, en: 'CMS edit' } },
    { ...posts[2], slug: 'different-post' },
    posts[3], { ...posts[3], _id: new ObjectId() },
  ];
  let reads = 0;
  const collection = {
    find(query) {
      reads++;
      assert.deepEqual(query.$or[0].slug.$in, posts.map(({ slug }) => slug));
      assert.deepEqual(query.$or[1]._id.$in, posts.map(({ _id }) => _id));
      return { toArray: async () => records };
    },
  };
  const plan = await planBlogSeed(collection, posts);
  assert.deepEqual(await planBlogSeed(collection, posts), plan);
  assert.deepEqual(plan.map(({ state }) => state), [
    'existing', 'conflict', 'conflict', 'conflict', ...Array(6).fill('missing'),
  ]);
  assert.match(plan[1].reason, /title/);
  assert.match(plan[2].reason, /ObjectId/);
  assert.match(plan[3].reason, /multiple/);
  assert.equal(reads, 2);
  assert.equal(records[1].title.en, 'CMS edit');
});
