---
type: Reference
title: "Workspace Model"
description: "A workspace is identified by the full tuple workspace.id, ownerUserId, incusProject, and incusContainer. The control plane resolves the authenticated actor and the host provisioner validates the same tuple before any"
---

# Workspace Model

A workspace is identified by the full tuple `workspace.id`, `ownerUserId`, `incusProject`, and `incusContainer`. The control plane resolves the authenticated actor and the host provisioner validates the same tuple before any Incus operation.

Runtime states include `running`, `stopped`, `starting`, `stopping`, `restarting`, `error`, and `unknown`. Setup phases describe toolchain and dotfiles readiness independently of container power state.

The current shared-prototype deployment can assign ownership to the authenticated actor or run without ownership checks for explicit local development. Configuration mutation remains separately gated by `INCUS_WEB_ALLOW_SHARED_CONFIG_MUTATION`.

See [Workspace Lifecycle](../workflows/workspace-lifecycle.md), [Provisioner Contract](provisioner-contract.md), and [Multi-Tenant Control Plane](multi-tenant-control-plane.md).
