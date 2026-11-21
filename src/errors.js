import { MongoError, MongoNetworkError, MongoServerError, MongoServerSelectionError } from 'mongodb';
import { BlogError } from './blog/validation.js';

export function reportError(message, error) {
  let category = '';
  if (error instanceof MongoServerSelectionError) category = ' (MongoDB server selection)';
  else if (error instanceof MongoNetworkError) category = ' (MongoDB network)';
  else if (error instanceof MongoServerError && Number.isInteger(error.code)) category = ` (MongoDB code ${error.code})`;
  else if (error instanceof MongoError) category = ' (MongoDB)';
  else if (error?.syscall === 'querySrv') category = ' (MongoDB SRV lookup)';
  else if (error?.code === 'EADDRINUSE') category = ' (address already in use)';
  console.error(`${message}${category}.`);
}

export function handleError(error, _request, response, _next) {
  if (response.headersSent) {
    reportError('API response interrupted', error);
    return response.destroy();
  }

  if (error.type === 'entity.parse.failed') {
    return response.status(400).json({ error: 'Invalid JSON', code: 'INVALID_JSON' });
  }
  if (error.type === 'entity.too.large') {
    return response.status(413).json({ error: 'Request body is too large', code: 'PAYLOAD_TOO_LARGE' });
  }
  if (error instanceof BlogError) {
    return response.status(error.status).json({ error: error.message, code: error.code, fields: error.fields });
  }
  if (error instanceof URIError && error.status === 400) {
    return response.status(400).json({ error: 'Invalid URL encoding', code: 'INVALID_REQUEST' });
  }

  reportError('API request failed', error);
  return response.status(500).json({ error: 'Internal server error' });
}
