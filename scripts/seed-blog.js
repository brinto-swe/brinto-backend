import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { MongoServerError, ObjectId } from 'mongodb';
import { ConfigError, loadConfig } from '../src/config.js';
import { createDatabase } from '../src/database.js';
import { reportError } from '../src/errors.js';
import { BlogError, derivePostFields, readPost, readStatus, requirePublishable } from '../src/blog/validation.js';

const frontend = new URL('../../portfolio-frontend/', import.meta.url);
const sourceDirectory = new URL('data/blog/', frontend);
const languages = ['en', 'bn'];
const expectedArticles = 10;

export async function loadBundledArticles() {
  // Node strips the TypeScript types. Resolve only the two imports used by these source files.
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === new URL('posts.ts', sourceDirectory).href && specifier === './schema') {
        return next(new URL('schema.ts', sourceDirectory).href, context);
      }
      if (context.parentURL === new URL('copy.ts', sourceDirectory).href && specifier === '@/data/portfolio') {
        return next(new URL('data/portfolio.ts', frontend).href, context);
      }
      return next(specifier, context);
    },
  });
  try {
    const { blogPosts } = await import(new URL('posts.ts', sourceDirectory).href);
    const { blogAuthor } = await import(new URL('copy.ts', sourceDirectory).href);
    return { articles: blogPosts, author: blogAuthor };
  } finally {
    hook.deregister();
  }
}

function seedId(slug, date) {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32BE(Math.floor(date.getTime() / 1000));
  createHash('sha256').update('brinto:bundled-blog:v1:' + slug).digest().copy(bytes, 4, 0, 8);
  return new ObjectId(bytes);
}

export function prepareSeedPosts({ articles, author }, now = new Date()) {
  if (articles.length !== expectedArticles || new Set(articles.map(({ id }) => id)).size !== expectedArticles) {
    throw new Error('Expected exactly ten unique bundled blog slugs.');
  }
  return articles.map((article) => {
    const input = {
      slug: article.id,
      title: article.title,
      excerpt: article.excerpt,
      tags: article.tags,
      categories: article.categories,
      content: article.content,
      author,
      featuredImage: article.cover === undefined ? null : { kind: 'sprite', tile: article.cover },
    };
    try {
      const post = readPost(input);
      for (const [key, original] of Object.entries(input)) {
        if (!isDeepStrictEqual(post[key], original)) throw new Error(`Validation changed the source field ${key}.`);
      }
      requirePublishable(post);
      const { status, publishedAt } = readStatus({ status: 'published', publishedAt: article.date }, now);
      if (typeof article.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(article.date)) {
        throw new Error('Expected a date-only publication value.');
      }
      if (!languages.every((locale) => Number.isSafeInteger(article.minutes?.[locale]) && article.minutes[locale] > 0)) {
        throw new Error('Invalid bundled reading times.');
      }
      const { searchText } = derivePostFields(post);
      return {
        _id: seedId(post.slug, publishedAt),
        ...post,
        status,
        publishedAt,
        minutes: { en: article.minutes.en, bn: article.minutes.bn },
        searchText,
      };
    } catch (error) {
      const detail = error instanceof BlogError ? Object.keys(error.fields ?? {}).join(', ') || error.code : error.message;
      throw new Error(`${article.id}: ${detail}`);
    }
  });
}

async function findMatches(collection, posts) {
  return collection.find({
    $or: [
      { slug: { $in: posts.map(({ slug }) => slug) } },
      { _id: { $in: posts.map(({ _id }) => _id) } },
    ],
  }, { timeoutMS: 8_000 }).toArray();
}

function classify(post, records) {
  const sameSlug = records.filter(({ slug }) => slug === post.slug);
  if (records.some(({ _id, slug }) => slug !== post.slug && post._id.equals(_id))) {
    return { state: 'conflict', reason: 'reserved ObjectId belongs to a different slug' };
  }
  if (sameSlug.length > 1) return { state: 'conflict', reason: 'multiple records already use this slug' };
  if (sameSlug.length === 0) return { state: 'missing' };
  const differences = Object.keys(post).filter((key) => key !== '_id' && !isDeepStrictEqual(post[key], sameSlug[0][key]));
  return differences.length
    ? { state: 'conflict', reason: 'existing fields differ: ' + differences.join(', ') }
    : { state: 'existing' };
}

export async function planBlogSeed(collection, posts) {
  const records = await findMatches(collection, posts);
  return posts.map((post) => ({ post, ...classify(post, records) }));
}

// Apply is exclusively opt-in. Require the existing full unique index so a
// concurrent Admin create cannot race a missing-slug check and create a duplicate.
export async function applyBlogSeed(collection, plan) {
  const pending = plan.filter(({ state }) => state === 'missing');
  if (!pending.length) return;
  const indexes = await collection.listIndexes({ timeoutMS: 8_000 }).toArray();
  if (!indexes.some(({ key, unique, sparse, partialFilterExpression, collation }) =>
    key.slug === 1 && Object.keys(key).length === 1 && unique === true &&
    !sparse && !partialFilterExpression && (!collation || collation.locale === 'simple'))) {
    throw new Error('Apply requires an existing full unique index on slug.');
  }
  for (const row of pending) {
    const now = new Date();
    try {
      await collection.insertOne({ ...row.post, createdAt: now, updatedAt: now }, { timeoutMS: 8_000 });
      row.state = 'inserted';
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      const resolved = classify(row.post, await findMatches(collection, [row.post]));
      if (resolved.state === 'missing') throw error;
      Object.assign(row, resolved);
    }
  }
}

function describe(plan) {
  return plan.map(({ post, state, reason }) => ({
    slug: post.slug,
    result: state,
    publication: post.status,
    dateUTC: post.publishedAt.toISOString().slice(0, 10),
    blocks: `${post.content.en.length}/${post.content.bn.length}`,
    images: languages.map((locale) => post.content[locale].filter(({ kind }) => kind === 'image').length).join('/'),
    sprite: post.featuredImage?.tile ?? 'none',
    minutes: `${post.minutes.en}/${post.minutes.bn}`,
    ...(reason && { reason }),
  }));
}

async function main(args) {
  const flag = args[0];
  if (args.length !== 1 || !['--dry-run', '--apply'].includes(flag)) {
    console.error('Usage: node scripts/seed-blog.js --dry-run | --apply');
    process.exitCode = 1;
    return;
  }
  let posts;
  let config;
  try {
    posts = prepareSeedPosts(await loadBundledArticles());
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) console.error(error.message);
    else console.error(`Could not prepare bundled blog posts: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const database = createDatabase(config);
  try {
    await database.connect({ prepareIndexes: false });
    const collection = database.collections.posts;
    const plan = await planBlogSeed(collection, posts);
    if (flag === '--apply') await applyBlogSeed(collection, plan);
    console.log(`Blog seed ${flag.slice(2)} for ${config.dbName}.posts. Blocks, images and minutes are EN/BN.`);
    console.table(describe(plan));
    const count = (state) => plan.filter((row) => row.state === state).length;
    console.log(`Validated ${posts.length}. Existing ${count('existing')}. Missing ${count('missing')}. Conflicts ${count('conflict')}. Inserted ${count('inserted')}.`);
  } catch (error) {
    reportError('Blog seed operation failed', error);
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main(process.argv.slice(2));
}
