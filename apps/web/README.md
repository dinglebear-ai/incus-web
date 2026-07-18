# incus-web control plane

Next.js 16/React 19 control plane for Incus workspaces. The UI uses the Aurora design system and communicates with the host provisioner and optional image-build worker over authenticated Unix sockets; it is not a standalone Vercel application.

## Development

```bash
npm ci
npm run dev
npm run lint
npm run test
npm run test:coverage
npm run build
```

For an intentionally local static prototype, configure `INCUS_WEB_DEV_ACTOR_USER_ID`, `INCUS_WEB_DEV_ACTOR_EMAIL`, and `INCUS_WEB_WORKSPACE_OWNER_MODE=none`. Production uses trusted reverse-proxy identity headers plus `INCUS_WEB_TRUSTED_PROXY_SECRET`.

Host-backed mode requires `INCUS_WEB_PROVISIONER_TOKEN` and `INCUS_WEB_PROVISIONER_SOCKET` (normally `/run/incus-web/provisioner.sock`). Builder features additionally require the build-worker token/socket and explicit actor/action gates. See the root `.env.example` and `openwiki/operations/configuration.md` for the complete reference.

## Browser tests

```bash
npx playwright install chromium
npm run test:e2e
```

The Playwright suite runs desktop/mobile Chromium and axe accessibility checks. Deployment is managed by the root `deploy.sh`, which builds a staged runtime and installs the hardened `incus-web-app.service` systemd unit.
