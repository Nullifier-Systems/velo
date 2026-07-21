export default async (req: any, res: any) => {
  try {
    const { app } = await import('../src/app.js');
    await app.ready();
    app.server.emit('request', req, res);
  } catch (err: any) {
    console.error('Vercel Serverless Error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'Serverless Function Crashed',
        detail: err.message,
        stack: err.stack,
      })
    );
  }
};
