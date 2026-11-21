import { randomUUID } from 'node:crypto';
import express, { Router } from 'express';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';

const formats = new Map([
  ['image/jpeg', 'jpeg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);
const purposes = new Set(['profile', 'project', 'certification-thumbnail', 'blog-cover', 'blog-content']);
const maxDimension = 6000;
const maxPixels = 20_000_000;
const multipartOverhead = 16 * 1024;

class UploadError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalidForm = () => new UploadError(400, 'INVALID_UPLOAD', 'Provide one image file and a valid purpose.');
const invalidImage = () => new UploadError(422, 'INVALID_IMAGE', 'The file is not a valid still image of the selected format.');
const tooLarge = () => new UploadError(413, 'IMAGE_TOO_LARGE', 'The image exceeds the upload size limit.');

async function readForm(request, maxBytes) {
  let form;
  try {
    form = await new Response(request.body, {
      headers: { 'content-type': request.get('Content-Type') },
    }).formData();
  } catch {
    throw invalidForm();
  }
  const image = form.get('image');
  const purpose = form.get('purpose');
  if ([...form.keys()].length !== 2 || !(image instanceof File) || !purposes.has(purpose)) {
    throw invalidForm();
  }
  if (image.size > maxBytes) throw tooLarge();
  if (!formats.has(image.type)) {
    throw new UploadError(415, 'UNSUPPORTED_IMAGE', 'Choose a JPEG, PNG, or WebP image.');
  }
  return { image, purpose };
}

function signatureMatches(bytes, format) {
  switch (format) {
    case 'jpeg': return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case 'png': return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'webp': return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  }
}

async function normalizeImage(file, maxBytes) {
  const format = formats.get(file.type);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!signatureMatches(bytes, format)) throw invalidImage();
  const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: maxPixels });
  let output;
  try {
    const { format: detected, width, height, pages } = await decoder.metadata();
    if (detected !== format || (pages ?? 1) !== 1) throw invalidImage();
    if (!width || !height || width > maxDimension || height > maxDimension || width * height > maxPixels) {
      throw new UploadError(422, 'INVALID_DIMENSIONS', 'Use an image within 6000 × 6000 pixels and 20 megapixels.');
    }
    // Decode the pixels and strip metadata and any appended data before forwarding bytes.
    output = await decoder.autoOrient().toFormat(format).timeout({ seconds: 5 })
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw invalidImage();
  }
  if (output.data.length > maxBytes) throw tooLarge();
  return output;
}

async function providerJson(response) {
  const decoder = new TextDecoder();
  let json = '';
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 16 * 1024) throw new Error();
    json += decoder.decode(chunk, { stream: true });
  }
  return JSON.parse(json + decoder.decode());
}

async function sendToImgBB(fetchImage, key, bytes, mimeType, timeoutMs) {
  const endpoint = new URL('https://api.imgbb.com/1/upload');
  endpoint.searchParams.set('key', key);
  const form = new FormData();
  form.set('image', new Blob([bytes], { type: mimeType }), `${randomUUID()}.${formats.get(mimeType)}`);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImage(endpoint, { method: 'POST', body: form, signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    const result = await providerJson(response);
    const { id, url } = result.data ?? {};
    if (result.success !== true || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) ||
        typeof url !== 'string' || url.length > 512 || !/^https:\/\/i\.ibb\.co\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/.test(url) ||
        url.includes(key) || url.split('/').some((part) => part === '..' || part === '.')) {
      throw new Error();
    }
    return { providerImageId: id, imageUrl: url };
  } catch {
    if (signal.aborted) throw new UploadError(504, 'IMAGE_PROVIDER_TIMEOUT', 'The image host timed out.');
    throw new UploadError(502, 'IMAGE_PROVIDER_FAILED', 'The image host could not complete the upload.');
  }
}

export function ownerMediaRoutes(config, collection, fetchImage = fetch) {
  const router = Router();
  const maxBytes = config.imageUploadMaxBytes ?? 5 * 1024 * 1024;
  const parse = express.raw({ type: 'multipart/form-data', limit: maxBytes + multipartOverhead, inflate: false });
  const providerTimeoutMs = config.imageProviderTimeoutMs ?? 10_000;
  const bodyTimeoutMs = config.imageBodyTimeoutMs ?? 15_000;

  router.post('/images', (request, response, next) => {
    if (!config.imgBBKey || !collection) {
      return response.status(503).json({ error: 'Image uploads are unavailable.', code: 'UPLOAD_UNAVAILABLE' });
    }
    if (!request.is('multipart/form-data')) {
      return response.status(415).json({ error: 'Use multipart/form-data.', code: 'UNSUPPORTED_REQUEST' });
    }
    const timeout = setTimeout(() => {
      response.set('Connection', 'close');
      response.once('finish', () => request.destroy());
      response.status(408).json({ error: 'The request took too long to upload.', code: 'UPLOAD_TIMEOUT' });
    }, bodyTimeoutMs);
    parse(request, response, (error) => {
      clearTimeout(timeout);
      if (response.headersSent || response.destroyed) return;
      if (error?.type === 'entity.too.large') return next(error);
      if (error) return response.status(400).json({ error: invalidForm().message, code: 'INVALID_UPLOAD' });
      return next();
    });
  }, async (request, response, next) => {
    try {
      const { image, purpose } = await readForm(request, maxBytes);
      const { data, info } = await normalizeImage(image, maxBytes);
      const mimeType = image.type;
      const { providerImageId, imageUrl } = await sendToImgBB(fetchImage, config.imgBBKey, data, mimeType, providerTimeoutMs);
      const _id = new ObjectId();
      const { width, height } = info;
      const fileSize = data.length;
      await collection.insertOne({
        _id, providerImageId, imageUrl, width, height, mimeType, fileSize, purpose,
        createdAt: new Date(), ownerId: response.locals.owner.id, attachmentState: 'unattached',
      }, { timeoutMS: 5_000 });
      return response.status(201).json({ assetId: _id.toHexString(), imageUrl, width, height, mimeType, fileSize });
    } catch (error) {
      if (error instanceof UploadError) return response.status(error.status).json({ error: error.message, code: error.code });
      return next(error);
    }
  });
  return router;
}
