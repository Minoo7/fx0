# fx0 on your tailnet

fx0's design UI, tools, chat history and libfx runtime, with Pi AI for model providers.
Provider support follows the pinned `@earendil-works/pi-ai` version. All of its
chat models are listed; availability depends on credentials and provider access.

## Deploy through Dokploy

Create a Docker Compose service from this repository, using `compose.yaml`.
Put provider environment variables in that service's **Environment** section.
For example, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`; never commit keys.
Set `FX0_MODEL` to a catalog ID such as `anthropic/claude-sonnet-4-5`.

Set `TS_AUTHKEY` to a Tailscale auth key in Environment, or complete the device
login URL in the Tailscale container's logs. Enable Serve in the tailnet.
Route `https://fx0.planasolutions.ai` through TSDProxy to the sidecar's tailnet
port 8080. Use a DNS-only record pointing to the shared private proxy. The target
URL must include `?fx0_proxy_key=<proxy secret>`, with the secret read
privately from `/secrets/proxy` in the proxy container. TSDProxy supplies the
authenticated user's identity headers. The loopback proxy removes that key
before forwarding requests to the app. Keep its target URL private.
Do not expose an application port or enable Funnel. No Vercel login is needed.

Alternatively, open **Model providers** from the account menu. Pi supplies each
provider's API-key, OAuth or device-code connection flow. Saved connections are
shared by this deployment and encrypted in Postgres; use a trusted personal
tailnet. Environment credentials follow Pi's own precedence and cannot be removed
by disconnecting a saved connection. Some providers require ambient cloud
credentials or provider-specific setup; consult [Pi AI](https://github.com/earendil-works/pi/tree/main/packages/ai).
Search providers by name and filter by **All**, **Connected**, or **Not connected**, then use **Remove saved credentials** to disconnect a
saved connection. Providers configured only through environment or cloud
credentials must be disconnected in Dokploy.

The stack creates Postgres, Redis, persistent application storage and a Tailscale
sidecar. Tailscale TCP Serve reaches the loopback identity proxy, which verifies
the shared secret before accepting TSDProxy identity headers. The app verifies
a private proxy secret and Tailscale identity on every request. Chat ownership is
enforced in Postgres; mutations require the same browser origin.

Back up the Postgres, Redis, application-data, secrets and Tailscale volumes
together. The secrets volume contains the encryption key: losing it prevents
decrypting saved provider credentials. Keep one application replica: provider
login prompts and active agent workers live in process, with libfx files on the
application-data volume. A container restart interrupts active work; reconnect
and send another message to continue. Vercel Queues recovery is not configured.

## Custom endpoints

`FX0_CUSTOM_PROVIDERS` accepts a JSON array of Pi OpenAI-compatible providers.
Each entry has `id`, `name`, `baseUrl`, optional `apiKeyEnv`, and `models` using
Pi's complete `Model<'openai-completions'>` schema. The models must name that
provider and API. Without `apiKeyEnv`, the endpoint is treated as unauthenticated.
Use `provider/model-id` in `FX0_MODEL`. This is server configuration, not browser
input; configure only endpoints you trust.

## Development and verification

Use Node 24 and Bun 1.3.8. `bun install --frozen-lockfile`, then `bun run build`.
`node scripts/init-secrets.mjs` initializes the secrets volume; local development
can set `FX0_SECRETS_DIR=.data/secrets`. Start real Postgres and Redis, run
`bun run db:migrate`, then `node scripts/start-selfhost.mjs`. See `.env.example`.
Use the custom domain through TSDProxy for browser access; raw localhost
requests intentionally return 403.

Checks: `bun run typecheck`, `bun run build`, and
`REDIS_URL=redis://127.0.0.1:6379 bun run test:journal:integration`.
The journal suite uses a unique key prefix and real Redis, including a second
process for streamed draft replay. A real provider connection is required to
verify prompt → tools → published design; catalog/auth checks alone do not prove
generation. Upstream Vercel OAuth/trial tests describe the upstream product,
not this deployment's authentication contract.

Based on [vercel-labs/fx0](https://github.com/vercel-labs/fx0), Apache-2.0.
