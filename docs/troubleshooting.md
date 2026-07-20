# Troubleshooting

## Common Issues

### Node dependencies are missing

Run:

```bash
npm install
```

### The API does not start

Check the local environment variables and confirm that the configured port is available.

### The contract build fails

Ensure the Rust toolchain and wasm target are installed and that the workspace dependencies are available.

### Changes do not appear in the frontend

Restart the Vite development server and confirm that the correct workspace is being served.

### An API request failed in production

Every API response carries an `x-request-id` header. Use it to pull all
log lines for that request — including each stage of the on-chain escrow
call — from Vercel's log viewer. See [Request Tracing](request-tracing.md)
for the step-by-step guide.

## Getting Help

Open a GitHub issue or consult the support documentation if the issue is not covered here.
