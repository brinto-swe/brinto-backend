import { MongoError, MongoNetworkError, MongoServerError, MongoServerSelectionError } from 'mongodb';

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
    return response.status(400).json({ error: 'Invalid JSON' });
  }
  if (error.type === 'entity.too.large') {
    return response.status(413).json({ error: 'Request body is too large' });
  }

  reportError('API request failed', error);
  return response.status(500).json({ error: 'Internal server error' });
}
