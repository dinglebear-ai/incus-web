# Testing

Run repository checks from the checkout root:

```bash
bash tests/deploy_static_tests.sh
node tests/build_worker_smoke.mjs
find scripts -type f -name '*.mjs' -print0 | xargs -0 node --check
find scripts tests -type f -name '*.sh' -print0 | xargs -0 bash -n
find scripts tests -type f -name '*.sh' -print0 | xargs -0 shellcheck
npm --prefix apps/web run lint
npm --prefix apps/web run test
npm --prefix apps/web run test:coverage
npm --prefix apps/web run build
```

Browser and accessibility smoke tests use Playwright:

```bash
npm --prefix apps/web run test:e2e
```

Vitest covers contracts, authorization, routes, components, persistence, and host-service subprocess integration. Static deployment tests protect service hardening, environment propagation, immutable workflow references, and deployment invariants. Playwright covers desktop/mobile Chromium and axe accessibility checks.
