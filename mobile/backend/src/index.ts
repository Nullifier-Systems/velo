import Fastify from 'fastify';
import 'dotenv/config';

const app = Fastify({ logger: true });

app.get('/health', async () => ({ ok: true }));

// TODO (Core Retail Flow P0): one identity per device (device-bound
// keypair, no email/password), real nearby-provider matching, chat
// coordination between user and provider. See
// docs/AUDIT_APK_WAVE6.md in the original MicoPay repo for the full
// acceptance criteria this backend needs to satisfy.

const port = Number(process.env.PORT ?? 3002);
app.listen({ port, host: '0.0.0.0' }).then(() => {
  app.log.info(`velo retail backend listening on :${port}`);
});
