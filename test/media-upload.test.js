import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';
import { createApp } from '../src/app.js';

const publicOrigin = 'http://localhost:3000';
const ownerEmail = 'owner@example.test';
const endpoint = '/api/admin/media/images';
const mockKey = 'fixture-imgbb-key';
const privateDeletionUrl = 'https://ibb.co/fixture/private-delete-token';
const imageUrl = 'https://i.ibb.co/fixture/test.png';
const pixels = (width = 6, height = 4) => sharp({
  create: { width, height, channels: 3, background: '#234597' },
});
const png = await pixels().png().toBuffer();

async function fixture(t, { config, provider, insert } = {}) {
  const documents = [];
  const calls = [];
  const auth = {
    api: { async getSession({ headers }) {
      const identity = headers.get('cookie')?.split('=')[1];
      if (!identity) return null;
      return {
        user: { id: 'fixture-owner-id', email: identity === 'guest' ? 'guest@example.test' : ownerEmail,
          emailVerified: identity !== 'unverified' },
        session: { expiresAt: new Date(Date.now() + (identity === 'expired' ? -1000 : 60_000)) },
      };
    } },
  };
  const database = { collections: { mediaAssets: {
    insertOne: insert ?? (async (document) => documents.push(document)),
  } } };
  const mediaFetch = async (url, options) => {
    calls.push({ url, options });
    if (provider) return provider(url, options);
    return Response.json({ success: true, data: { id: 'fixture', url: imageUrl, delete_url: privateDeletionUrl } });
  };
  const server = createApp({
    auth, database, mediaFetch,
    config: { publicOrigin, ownerEmail, imgBBKey: mockKey, imageUploadMaxBytes: 1024, ...config },
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (body, { identity = 'owner', origin = publicOrigin, headers = {} } = {}) => fetch(base + endpoint, {
    method: 'POST', body, headers: { Origin: origin, ...(identity ? { Cookie: `fixture=${identity}` } : {}), ...headers },
  });
  return { base, request, calls, documents };
}

function form(bytes = png, mimeType = 'image/png', purpose = 'profile') {
  const data = new FormData();
  data.set('image', new Blob([bytes], { type: mimeType }), 'claim.png');
  data.set('purpose', purpose);
  return data;
}

test('existing owner and origin checks run before media configuration or parsing', async (t) => {
  const { request, calls } = await fixture(t, { config: { imgBBKey: undefined } });
  for (const [identity, status] of [[null, 401], ['guest', 403], ['unverified', 403], ['expired', 401]]) {
    assert.equal((await request('not multipart', { identity })).status, status);
  }
  assert.equal((await request(form(), { origin: 'https://wrong.example' })).status, 403);
  const unavailable = await request(form());
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, 'UPLOAD_UNAVAILABLE');
  assert.equal(calls.length, 0);
});

test('accepts decoded PNG, JPEG and WebP and stores only validated metadata', async (t) => {
  const { request, calls, documents } = await fixture(t);
  for (const [format, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]) {
    const bytes = await pixels().toFormat(format).toBuffer();
    const response = await request(form(bytes, mime, 'blog-cover'));
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    const { url, options } = calls.at(-1);
    const sent = options.body.get('image');
    assert.equal(url.origin + url.pathname, 'https://api.imgbb.com/1/upload');
    assert.equal(url.searchParams.get('key'), mockKey);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(sent.type, mime);
    assert.notEqual(sent.name, 'claim.png');
    const metadata = await sharp(Buffer.from(await sent.arrayBuffer())).metadata();
    assert.equal(metadata.format, format);
    assert.equal(metadata.exif, undefined);
    const saved = documents.at(-1);
    assert.ok(saved._id instanceof ObjectId);
    assert.ok(saved.createdAt instanceof Date);
    assert.deepEqual(saved, {
      _id: saved._id, providerImageId: 'fixture', imageUrl, width: 6, height: 4,
      mimeType: mime, fileSize: sent.size, purpose: 'blog-cover', ownerId: 'fixture-owner-id',
      createdAt: saved.createdAt, attachmentState: 'unattached',
    });
    assert.deepEqual(body, {
      assetId: saved._id.toHexString(), imageUrl, width: 6, height: 4, mimeType: mime, fileSize: sent.size,
    });
    assert.ok(!JSON.stringify(body).includes(privateDeletionUrl));
  }
});

test('rejects invalid multipart, duplicate fields, remote URL and invalid purpose', async (t) => {
  const { request, calls } = await fixture(t);
  assert.equal((await request('https://example.test/image.png')).status, 415);
  const duplicate = form();
  duplicate.append('image', new Blob([png], { type: 'image/png' }), 'second.png');
  const remote = form();
  remote.set('image', 'https://example.test/image.png');
  for (const invalid of [duplicate, remote, form(png, 'image/png', 'anything')]) {
    assert.equal((await request(invalid)).status, 400);
  }
  assert.equal((await request('broken body', { headers: { 'Content-Type': 'multipart/form-data' } })).status, 400);
  assert.equal(calls.length, 0);
});

test('rejects unsupported, spoofed, malformed and oversized images before calling ImgBB', async (t) => {
  const { request, calls } = await fixture(t);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
  const testCases = [
    [form(svg, 'image/svg+xml'), 415],
    [form(svg), 422],
    [form(Buffer.from([0x4d, 0x5a])), 422],
    [form(png, 'image/jpeg'), 422],
    [form(png.subarray(0, 43)), 422],
    [form(await pixels(6001, 1).png().toBuffer()), 422],
    [form(Buffer.alloc(1025)), 413],
    [form(Buffer.alloc(18 * 1024)), 413],
  ];
  for (const [input, expected] of testCases) {
    assert.equal((await request(input)).status, expected);
  }
  assert.equal(calls.length, 0);
});

test('a slow request body returns a sanitized 408', async (t) => {
  const { base, calls } = await fixture(t, { config: { imageBodyTimeoutMs: 30 } });
  const response = await new Promise((resolve, reject) => {
    const input = http.request(base + endpoint, {
      method: 'POST',
      headers: { Cookie: 'fixture=owner', Origin: publicOrigin, 'Content-Type': 'multipart/form-data; boundary=test',
        'Content-Length': '90' },
    }, resolve);
    input.on('error', reject);
    input.write('--test\r\n');
  });
  assert.equal(response.statusCode, 408);
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  assert.equal(JSON.parse(Buffer.concat(chunks)).code, 'UPLOAD_TIMEOUT');
  assert.equal(calls.length, 0);
});

test('maps provider timeout to 504 without persisting anything', async (t) => {
  const { request, documents } = await fixture(t, {
    config: { imageProviderTimeoutMs: 30 },
    provider: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const timedOut = await request(form());
  assert.equal(timedOut.status, 504);
  assert.equal((await timedOut.json()).code, 'IMAGE_PROVIDER_TIMEOUT');
  assert.equal(documents.length, 0);
});

test('sanitizes provider failure, network exceptions and invalid provider URLs', async (t) => {
  const { request, documents } = await fixture(t, {
    provider: (url) => {
      throw new Error(`${url.href} ${privateDeletionUrl}`);
    },
  });
  const response = await request(form());
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'The image host could not complete the upload.', code: 'IMAGE_PROVIDER_FAILED' });
  assert.equal(documents.length, 0);
  const invalid = [
    () => Response.json({ error: mockKey, delete_url: privateDeletionUrl }, { status: 429 }),
    () => Response.json({ success: true, data: { id: 'fixture', url: privateDeletionUrl } }),
    () => Response.json({ success: true, data: { id: 'fixture', url: imageUrl + '?secret=' + mockKey } }),
    () => new Response('x'.repeat(17 * 1024)),
  ];
  for (const provider of invalid) {
    const instance = await fixture(t, { provider });
    const bad = await instance.request(form());
    assert.equal(bad.status, 502);
    const body = await bad.text();
    assert.ok(!body.includes(mockKey) && !body.includes(privateDeletionUrl));
    assert.equal(instance.documents.length, 0);
  }
});

test('a failed asset insert cannot return success or expose provider data', async (t) => {
  const { request, calls } = await fixture(t, {
    insert: async () => { throw new Error(privateDeletionUrl); },
  });
  const response = await request(form());
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal server error' });
  assert.equal(calls.length, 1);
});
