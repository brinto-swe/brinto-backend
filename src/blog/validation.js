import { ObjectId } from 'mongodb';

export const categories = ['ai', 'ml', 'neuro', 'agriculture', 'web', 'engineering', 'research', 'tutorial'];
export const statuses = ['draft', 'published', 'archived'];
const languages = ['en', 'bn'];
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const inlineMarks = ['bold', 'italic', 'underline', 'code'];
const inlineColors = ['blue', 'teal', 'purple', 'red'];
const maxListDepth = 4;

export class BlogError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    Object.assign(this, { status, code, fields });
  }
}

function malformed(message) {
  throw new BlogError(400, 'INVALID_REQUEST', message);
}

function invalid(field, message) {
  throw new BlogError(422, 'INVALID_POST', 'Invalid blog content', { [field]: message });
}

function object(value, path, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'Expected an object.');
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid(path, 'Contains unsupported fields.');
  return value;
}

function string(value, path, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    invalid(path, required ? `Enter nonblank text up to ${max} characters.` : `Enter text up to ${max} characters.`);
  }
  return value;
}

function array(value, path, max, map, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    invalid(path, `Enter ${min}–${max} items.`);
  }
  return value.map((item, index) => map(item, `${path}.${index}`));
}

function integer(value, path, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) invalid(path, `Enter an integer from ${min} to ${max}.`);
  return value;
}

function choice(value, path, options) {
  if (!options.includes(value)) invalid(path, 'Choose a supported value.');
  return value;
}

function localized(value, path, previous, read) {
  const input = object(value, path, languages);
  return Object.fromEntries(languages.map((language) => [
    language,
    Object.hasOwn(input, language) ? read(input[language], `${path}.${language}`) : previous[language],
  ]));
}

function url(value, path, anchors = false) {
  const input = string(value, path, 2048, true);
  if (!/[\s\\\u0000-\u001f\u007f]/u.test(input)) {
    if (input.startsWith('/') && !input.startsWith('//')) return input;
    if (anchors && /^#[a-z\d-]+$/i.test(input)) return input;
    if (anchors ? /^https:\/\/[^/]/i.test(input) : input.startsWith('https://')) {
      const parsed = URL.parse(input);
      if (parsed?.hostname && !parsed.username && !parsed.password) return input;
    }
  }
  invalid(path, anchors ? 'Use an HTTPS URL, site-relative path, or simple anchor.' : 'Use an HTTPS URL or site-relative path.');
}

function inline(value, path) {
  if (typeof value === 'string') return string(value, path, 8000);
  if (value?.kind === 'span') {
    const part = object(value, path, ['kind', 'text', 'marks', 'color', 'href']);
    const text = string(part.text, `${path}.text`, 8000);
    if (!text.length || (Object.hasOwn(part, 'href') && !text.trim())) {
      invalid(`${path}.text`, 'Enter text for the span. Link text cannot be blank.');
    }
    const span = { kind: 'span', text };
    if (Object.hasOwn(part, 'marks')) {
      const marksPath = `${path}.marks`;
      span.marks = array(part.marks, marksPath, inlineMarks.length, (mark, field) => choice(mark, field, inlineMarks));
      if (new Set(span.marks).size !== span.marks.length) invalid(marksPath, 'Marks must be unique.');
    }
    if (Object.hasOwn(part, 'color')) span.color = choice(part.color, `${path}.color`, inlineColors);
    if (Object.hasOwn(part, 'href')) span.href = url(part.href, `${path}.href`, true);
    return span;
  }
  const isLink = value?.kind === 'link';
  const part = object(value, path, isLink ? ['kind', 'text', 'href'] : ['kind', 'text']);
  const text = string(part.text, `${path}.text`, 8000, true);
  if (isLink) return { kind: 'link', text, href: url(part.href, `${path}.href`, true) };
  return { kind: choice(part.kind, `${path}.kind`, ['strong', 'emphasis', 'code']), text };
}

const inlineParts = (value, path) => array(value, path, 100, inline, 1);
const textOf = (parts) => parts.map((part) => typeof part === 'string' ? part : part.text).join('');

function headingText(value, path) {
  if (!Array.isArray(value)) return string(value, path, 300, true);
  const parts = inlineParts(value, path);
  string(textOf(parts), path, 300, true);
  return parts;
}

function listBlock(value, path, depth = 1) {
  if (depth > maxListDepth) invalid(path, 'Lists can contain up to four levels.');
  object(value, path, ['kind', 'ordered', 'items']);
  choice(value.kind, `${path}.kind`, ['list']);
  if (typeof value.ordered !== 'boolean') invalid(`${path}.ordered`, 'Expected a boolean.');
  const items = array(value.items, `${path}.items`, 100, (item, field) => {
    if (Array.isArray(item)) return inlineParts(item, field);
    object(item, field, ['text', 'children']);
    return {
      text: inlineParts(item.text, `${field}.text`),
      children: array(item.children, `${field}.children`, 100,
        (child, childPath) => listBlock(child, childPath, depth + 1), 1),
    };
  }, 1);
  return { kind: 'list', ordered: value.ordered, items };
}

function imageSize(value, path) {
  return {
    src: url(value.src, `${path}.src`),
    width: integer(value.width, `${path}.width`, 1, 10000),
    height: integer(value.height, `${path}.height`, 1, 10000),
  };
}

function block(value, path) {
  switch (value?.kind) {
    case 'heading':
      object(value, path, ['kind', 'level', 'text']);
      return { kind: value.kind, level: choice(value.level, `${path}.level`, [2, 3]), text: headingText(value.text, `${path}.text`) };
    case 'paragraph':
    case 'quote':
      object(value, path, ['kind', 'text']);
      return { kind: value.kind, text: inlineParts(value.text, `${path}.text`) };
    case 'list':
      return listBlock(value, path);
    case 'code':
      object(value, path, ['kind', 'language', 'code', 'caption']);
      return {
        kind: value.kind,
        language: string(value.language, `${path}.language`, 50, true),
        code: string(value.code, `${path}.code`, 16000, true),
        caption: string(value.caption, `${path}.caption`, 1000),
      };
    case 'image':
      object(value, path, ['kind', 'src', 'width', 'height', 'alt', 'caption']);
      return {
        kind: value.kind,
        ...imageSize(value, path),
        alt: string(value.alt, `${path}.alt`, 500),
        caption: string(value.caption, `${path}.caption`, 1000),
      };
    default:
      invalid(`${path}.kind`, 'Choose a supported article block.');
  }
}

function featuredImage(value, path) {
  if (value === null) return null;
  if (value?.kind === 'sprite') {
    object(value, path, ['kind', 'tile']);
    return { kind: value.kind, tile: integer(value.tile, `${path}.tile`, 0, 5) };
  }
  if (value?.kind !== 'image') invalid(`${path}.kind`, 'Choose a sprite or image.');
  object(value, path, ['kind', 'src', 'width', 'height', 'alt']);
  const alt = object(value.alt, `${path}.alt`, languages);
  return {
    kind: value.kind,
    ...imageSize(value, path),
    alt: { en: string(alt.en, `${path}.alt.en`, 500), bn: string(alt.bn, `${path}.alt.bn`, 500) },
  };
}

function tags(value, path) {
  const results = array(value, path, 20, (item, field) => string(item, field, 60, true).trim());
  if (new Set(results.map(normalize)).size !== results.length) invalid(path, 'Tags must be unique.');
  return results;
}

const emptyText = { en: '', bn: '' };
const emptyLists = { en: [], bn: [] };
const localizedText = (max) => (value, path, previous = emptyText) =>
  localized(value, path, previous, (text, name) => string(text, name, max));

function seo(value, path, previous) {
  if (value === null) return null;
  const input = object(value, path, ['title', 'description']);
  const output = { ...previous };
  if (Object.hasOwn(input, 'title')) output.title = localizedText(150)(input.title, 'seo.title', previous?.title);
  if (Object.hasOwn(input, 'description')) output.description = localizedText(320)(input.description, 'seo.description', previous?.description);
  return output;
}

const editable = {
  title: localizedText(200),
  excerpt: localizedText(1200),
  author: localizedText(120),
  tags: (value, path, previous = emptyLists) => localized(value, path, previous, tags),
  content: (value, path, previous = emptyLists) => localized(
    value, path, previous, (items, name) => array(items, name, 120, block),
  ),
  categories(value, path) {
    const values = array(value, path, categories.length, (item, name) => choice(item, name, categories));
    if (new Set(values).size !== values.length) invalid(path, 'Categories must be unique.');
    return values;
  },
  featuredImage,
  seo,
  visibility: (value, path) => choice(value, path, ['public', 'hidden']),
  sortOrder: (value, path) => integer(value, path, -1000000, 1000000),
};

const defaults = {
  title: emptyText, excerpt: emptyText, author: emptyText, tags: emptyLists, content: emptyLists,
  categories: [], featuredImage: null, seo: null, visibility: 'public', sortOrder: 0,
};

function validSlug(value) {
  return typeof value === 'string' && value.length <= 100 && slugPattern.test(value);
}

export function readSlug(value) {
  if (!validSlug(value)) malformed('Invalid post slug');
  return value;
}

export function readId(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) malformed('Invalid post ID');
  return new ObjectId(value);
}

function bodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) malformed('Expected a JSON object');
}

export function readPost(body, previous) {
  bodyObject(body);
  const keys = Object.keys(editable);
  object(body, 'post', previous ? keys : [...keys, 'slug']);
  if (previous && !Object.keys(body).length) invalid('post', 'Provide at least one editable field.');
  if (!previous && !validSlug(body.slug)) invalid('slug', 'Use lowercase letters, numbers, and hyphens, up to 100 characters.');

  const post = Object.fromEntries(keys.map((key) => [
    key,
    Object.hasOwn(body, key) ? editable[key](body[key], key, previous?.[key]) : (previous ?? defaults)[key],
  ]));
  if (Buffer.byteLength(JSON.stringify(post.content)) > 90 * 1024) {
    invalid('content', 'The combined article content must fit within 90 KiB.');
  }
  return previous ? post : { slug: body.slug, ...post };
}

export function normalize(text) {
  return text.normalize('NFC').toLowerCase().replace(/[\u200b-\u200d]/g, '');
}

function blockText(block) {
  switch (block.kind) {
    case 'heading': return typeof block.text === 'string' ? block.text : textOf(block.text);
    case 'paragraph':
    case 'quote': return textOf(block.text);
    case 'list': return block.items.map((item) => Array.isArray(item)
      ? textOf(item)
      : [textOf(item.text), ...item.children.map(blockText)].join(' ')).join(' ');
    case 'code': return `${block.language} ${block.caption} ${block.code}`;
    case 'image': return `${block.caption} ${block.alt}`;
  }
}

export function derivePostFields(post) {
  const bodyText = Object.fromEntries(languages.map((locale) => [locale, post.content[locale].map(blockText).join(' ')]));
  const minutes = Object.fromEntries(languages.map((locale) => {
    const body = normalize(bodyText[locale]).trim();
    return [locale, body ? Math.ceil(body.split(/\s+/u).length / 200) : Number(post.content[locale].length > 0)];
  }));
  const searchText = normalize(languages.flatMap((locale) => [
    post.author[locale], post.title[locale], post.excerpt[locale], ...post.tags[locale], bodyText[locale],
  ]).join(' '));
  return { minutes, searchText };
}

export function requirePublishable(post) {
  for (const locale of languages) {
    for (const field of ['title', 'excerpt', 'author']) {
      if (!post[field][locale].trim()) invalid(`${field}.${locale}`, 'Required for publication.');
    }
    if (!post.content[locale].some((entry) => entry.kind === 'image' || normalize(blockText(entry)).trim())) {
      invalid(`content.${locale}`, 'Add article content before publishing.');
    }
  }
  if (!post.categories.length) invalid('categories', 'Choose at least one category before publishing.');
}

export function readStatus(body, now) {
  bodyObject(body);
  object(body, 'post', ['status', 'publishedAt']);
  const status = choice(body.status, 'status', statuses);
  if (!Object.hasOwn(body, 'publishedAt')) return { status };
  if (status !== 'published') invalid('publishedAt', 'Set publication time only when publishing.');
  const value = body.publishedAt;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value)) {
    invalid('publishedAt', 'Use an ISO UTC date or timestamp.');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10) || date > now) {
    invalid('publishedAt', 'Choose a valid publication time at or before the present.');
  }
  return { status, publishedAt: date };
}

function queryInteger(value, fallback, max, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d{0,5}$/.test(value) || Number(value) > max) malformed(`Invalid ${name}`);
  return Number(value);
}

export function readListQuery(query, admin = false) {
  const keys = admin ? ['q', 'category', 'status', 'page', 'limit'] : ['q', 'category', 'cursor', 'limit'];
  if (Object.keys(query).some((key) => !keys.includes(key))) malformed('Unsupported query parameter');
  const { q = '', category, status, cursor } = query;
  if (typeof q !== 'string' || q.length > 200) malformed('Invalid search query');
  const words = [...new Set(normalize(q).trim().split(/\s+/u).filter(Boolean))].sort();
  if (words.length > 16) malformed('Search accepts up to 16 words');
  if (category !== undefined && !categories.includes(category)) malformed('Invalid category');
  if (status !== undefined && !statuses.includes(status)) malformed('Invalid status');
  if (cursor !== undefined && (typeof cursor !== 'string' || !/^[\w-]{1,700}\.[\w-]{43}$/.test(cursor))) malformed('Invalid cursor');
  const limit = queryInteger(query.limit, admin ? 5 : 6, 50, 'limit');
  const page = admin ? queryInteger(query.page, 1, 10000, 'page') : undefined;
  return { words, category, status, cursor, limit, page };
}
