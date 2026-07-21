import 'dotenv/config';

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

export function requireAdminAuth(request: any, reply: any): boolean {
  if (!ADMIN_API_KEY) {
    reply.code(503).send({
      error: 'Admin API key not configured. Set ADMIN_API_KEY environment variable.',
    });
    return false;
  }

  const authHeader = request.headers['authorization'];
  if (!authHeader || typeof authHeader !== 'string') {
    reply.code(401).send({ error: 'Missing Authorization header' });
    return false;
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    reply.code(401).send({ error: 'Authorization header must be: Bearer <admin-api-key>' });
    return false;
  }

  if (token !== ADMIN_API_KEY) {
    reply.code(403).send({ error: 'Invalid admin API key' });
    return false;
  }

  return true;
}
