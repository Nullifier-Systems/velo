import { app } from './app.js';
import { cashRoutes } from './routes/cash.js';
import { adminRoutes } from './routes/admin.js';

const port = Number(process.env.PORT ?? 3000);

// Initialize and register routes before starting the server
async function startServer() {
  try {
    // Register User Cash & Geolocation discovery routes (with /api/v1 prefix)
    await app.register(cashRoutes, { prefix: '/api/v1' });

    // Register Admin/Ops monitoring & intervention routes (with /api/v1 prefix)
    await app.register(adminRoutes, { prefix: '/api/v1' });

    // Start listening
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`velo api listening on :${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

startServer();
