import { fromNodeHeaders } from 'better-auth/node';

export function requireOwner(auth, config) {
  return async (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      query: { disableCookieCache: true, disableRefresh: true },
    });

    if (!session || !(new Date(session.session.expiresAt).getTime() > Date.now())) {
      return response.status(401).json({ error: 'Authentication required' });
    }
    if (!session.user.emailVerified || session.user.email.toLowerCase() !== config.ownerEmail) {
      return response.status(403).json({ error: 'Owner access required' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.get('Origin') !== config.publicOrigin) {
      return response.status(403).json({ error: 'Untrusted origin' });
    }
    response.locals.owner = session.user;
    return next();
  };
}
