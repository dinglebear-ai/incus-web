# Incus Web Agent Instructions

Incus Web builds an x86_64 Incus image and a Next.js control plane for isolated
agent workspaces. Preserve the product boundary documented under
`docs/contracts/`: the web application calls narrow product operations and
never receives raw Incus host credentials.

## Source of truth

- `CLAUDE.md` is the editable agent-memory file. `AGENTS.md` and `GEMINI.md`
  must remain symlinks to it.
- `distrobuilder.yaml` defines the image.
- `incus-web-profile.yaml` defines the runtime profile.
- `apps/web/` contains the control plane.
- `scripts/build-image.sh` and `scripts/smoke-image.sh` own image construction
  and smoke testing.
- `.github/workflows/` contains thin callers pinned to
  `dinglebear-ai/workflows`.

## Build and test

```bash
npm ci --prefix apps/web
npm --prefix apps/web run lint
npm --prefix apps/web run test:coverage
npm --prefix apps/web run build
bash tests/deploy_static_tests.sh
node --test tests/export_onboarding_test.mjs
node tests/build_worker_smoke.mjs
node tests/check_markdown_links.mjs
```

Incus image builds, deployment-path smoke tests, and image publication are
release-only jobs on GitHub-hosted x86_64 runners. Fast Linux web and policy
checks run on the runner farm. The image contract supports x86_64 only.

## Safety

- Keep secrets outside images and git. Only `.env.example` is tracked.
- Preserve the host-provisioner boundary and its metadata revalidation.
- Do not weaken the disposable workspace, credential, or shifted-mount
  contracts to make CI pass.
- Do not publish rolling artifacts from `main`; attach verified artifacts to a
  published GitHub release.
