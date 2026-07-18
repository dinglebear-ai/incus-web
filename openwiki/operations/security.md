# Security

## Overview

incus-web implements defense-in-depth with multiple security boundaries: unprivileged containers, network ACLs, provisioner isolation, and OIDC/Tailscale authentication.

## Security Boundaries

### 1. User ↔ Control Plane

**Boundary**: OIDC reverse-proxy or Tailscale authentication

**Enforcement**:
- Only authenticated identities reach control plane
- OIDC provider validates identity
- TLS encrypts all traffic

**Threat model**:
- Attacker without valid credentials cannot access control plane
- Attacker with compromised credentials has user-level access

**Mitigations**:
- Use MFA on OIDC provider
- Use short-lived Tailscale auth keys
- Monitor access logs

### 2. Control Plane ↔ Provisioner

**Boundary**: Unix socket with bearer token authentication

**Enforcement**:
- Only control-plane service user has token
- Socket permissions limit to trusted group
- Provisioner validates all commands

**Threat model**:
- Compromised control plane could send unauthorized commands
- Attacker with socket access could send commands

**Mitigations**:
- Run control plane as dedicated service user
- Use strong bearer token (32+ bytes)
- Limit socket access to specific group
- Validate all metadata before mutation
- Redact sensitive values from logs

### 3. Provisioner ↔ Incus

**Boundary**: Incus Unix socket (root-owned)

**Enforcement**:
- Only provisioner service user has Incus access
- Incus enforces container-level isolation

**Threat model**:
- Attacker with provisioner token could create containers
- Attacker with Incus access could escape to host

**Mitigations**:
- Run provisioner as unprivileged service user
- Use `incus-admin` group for limited Incus access
- Never run containers as privileged by default
- Use AppArmor profiles for nested containers

### 4. Workspace ↔ Host

**Boundary**: Incus container isolation

**Enforcement**:
- Unprivileged containers
- Network ACLs block RFC1918 access
- No direct host access by default

**Threat model**:
- Attacker in workspace could exploit kernel vulnerability
- Attacker could exploit container escape
- Attacker could exploit nesting to break out

**Mitigations**:
- Run unprivileged containers (`security.privileged=false`)
- Use AppArmor confinement
- Block RFC1918 and link-local egress
- Monitor container resource usage
- Keep kernel updated

## Container Security

### Unprivileged by Default

```yaml
# incus-web-profile.yaml
security.privileged: "false"
security.nesting: "true"
```

- Unprivileged containers: root in container is unprivileged on host
- Nesting enabled: allows Docker/Incus workflows inside container
- AppArmor profile: confines nested systemd and processes

### AppArmor Profile

```yaml
raw.apparmor: |-
  signal peer=@{profile_name}//&unconfined,
```

Allows signal(2) for nested systemd, preventing EPERM on service stops.

### Resource Limits

```yaml
limits.cpu: "2"
limits.memory: 4GiB
limits.memory.enforce: "hard"
limits.processes: "2048"
```

Prevents resource exhaustion attacks.

### User Isolation

Container runs as non-root user `agent`:
```bash
useradd -m -s /bin/zsh agent
systemctl enable wetty@agent
```

Terminal users:
- Cannot escalate to root
- Cannot access host system
- Cannot modify other containers

## Network Security

### ACL Blocking

```bash
incus network acl create agent-block-lan
```

Blocks egress to:
- `10.0.0.0/8` (RFC1918 private)
- `172.16.0.0/12` (RFC1918 private)
- `192.168.0.0/16` (RFC1918 private)
- `169.254.0.0/16` (IPv4 link-local)

**Purpose**:
- Prevents workspace scanning internal networks
- Contains lateral movement
- Forces explicit network configuration

### Dedicated Bridge

```bash
incus network create agentbr0 ipv4.address=198.18.0.1/15
```

- Isolates workspace traffic from host network
- Allows per-bridge ACLs
- Prevents container-to-container communication

### Tailscale

```bash
TS_AUTHKEY=tskey-auth-<ephemeral-key>
TS_HOSTNAME=incus-web
```

- Ephemeral keys: disposable, time-limited
- Tailscale Serve: HTTPS without certificate management
- Tailnet-only access: no public exposure

### OIDC Reverse Proxy

```bash
OIDC_ISSUER_URL=https://auth.example.com
OIDC_REVERSE_PROXY=true
```

- TLS terminates upstream (e.g., nginx, Cloudflare)
- oauth2-proxy validates OIDC tokens
- Container never sees plaintext traffic

## Provisioner Security

### Token Authentication

```typescript
type ProvisionerServiceAuth = {
  scheme: "bearer"
  token: string
}
```

- Token is not a user token
- Token does not carry authorization claims
- Token proves caller is trusted service
- Authorization resolved by control plane

### Metadata Validation

Provisioner validates all metadata before mutation:
```javascript
function validateWorkspaceMetadata(command) {
  if (command.workspaceId !== `workspace-${command.incusContainer}`) {
    throw new Error("metadata_mismatch")
  }
  // ... more validation
}
```

### Command Validation

Provisioner validates command format and values:
```javascript
function validateCommand(command) {
  if (!PROVISIONER_COMMAND_TYPES.includes(command.command)) {
    throw new Error("invalid_input")
  }
  // ... more validation
}
```

### Status Caching

Status caching reduces Incus query rate, preventing:
- DoS via rapid status queries
- Incus socket exhaustion
- Excessive logging

### Redacted Logs

Sensitive values redacted from logs:
```javascript
function redactForLogging(command) {
  return {
    ...command,
    repositoryUrl: "[REDACTED]",
    task: "[REDACTED]",
  }
}
```

## Credential Isolation

### Agent Run Credentials

Agent runs clone golden container and inject credentials:
```bash
# Copy from source container
incus file push incus-web~/.config/gh/config.yml <run-id>~/.config/gh/
incus file push incus-web~/.gitconfig <run-id>~/
incus file push -r incus-web~/.ssh <run-id>~/
```

**Isolation**:
- Credentials injected into ephemeral container
- Container deleted after run completes
- Credentials never leave container

**Stale detection**:
```javascript
const currentHash = hashCredentials(sourceContainer)
const goldenHash = incus config get golden-container agent.credential_hash

if (currentHash !== goldenHash) {
  throw new Error("Stale credentials. Rebuild golden container")
}
```

### Terminal Access

Terminal users share container and Linux user:
- Same UID/GID across all terminal sessions
- Same home directory
- Same processes

**Warning**:
UI must show same-user shared-container warning before granting access.

## Authorization

### Current Prototype

Single workspace with configurable owner:
```bash
INCUS_WEB_WORKSPACE_OWNER_MODE=authenticated
```

Current OIDC user owns workspace. Other users denied.

### Future Multi-Tenant

Planned database-backed authorization:
```typescript
// Workspace ownership
workspace.ownerUserId === actor.userId

// Granted access
db.workspaceGrants.find({
  workspaceId,
  userId: actor.userId,
})

// Role-based permissions
ROLE_PERMISSIONS[grant.role][action]
```

## Secrets Management

### Never Commit Secrets

```bash
# .gitignore
.env
.env.local
*.key
*.pem
```

### Environment Files

```bash
# .env (local development)
chmod 600 .env

# /etc/incus-web/provisioner.env (mode 0640)
chmod 0640 /etc/incus-web/provisioner.env
chown root:incus-web /etc/incus-web/provisioner.env
```

### Token Generation

```bash
# Generate strong token
TOKEN=$(openssl rand -base64 32)
```

### Token Rotation

1. Generate new token
2. Update env files
3. Restart services
4. Old token immediately invalid

## Audit and Monitoring

### Logs

**Provisioner logs**:
```bash
sudo journalctl -u incus-web-provisioner -f
```

**Control plane logs**:
```bash
sudo journalctl -u incus-web-app -f
```

**Container logs**:
```bash
incus exec incus-web -- journalctl -f
```

### Metrics

`GET /metrics` exports process uptime and control-plane, state-store, and provisioner readiness gauges. Runtime command, authentication, restart, and queue events remain available through the systemd journals for aggregation.

### Alerts

Alert on sustained readiness failure, provisioner authentication failures, service restart loops, and build-queue growth. See [Monitoring and Alerts](monitoring.md) for thresholds and response steps.

## Hardening Checklist

### Host

- [ ] Keep kernel updated
- [ ] Keep Incus updated
- [ ] Enable AppArmor enforcement
- [ ] Use strong password for sudo
- [ ] Limit sudo access
- [ ] Enable firewall (ufw, iptables)
- [ ] Monitor logins

### Incus

- [ ] Run unprivileged containers by default
- [ ] Use AppArmor profiles
- [ ] Enable resource limits
- [ ] Use dedicated bridge with ACLs
- [ ] Limit Incus access to specific users
- [ ] Monitor container resource usage

### Provisioner

- [ ] Use strong bearer token (32+ bytes)
- [ ] Limit socket access to specific group
- [ ] Validate all commands and metadata
- [ ] Redact sensitive values from logs
- [ ] Enable status caching
- [ ] Monitor provisioner logs

### Control Plane

- [ ] Use MFA on OIDC provider
- [ ] Use short-lived Tailscale keys
- [ ] Enable TLS (with upstream termination)
- [ ] Validate authorization before commands
- [ ] Monitor access logs

## Known Limitations

### Prototype Mode

Current prototype uses single shared workspace:
- All authenticated users share same container
- Same Linux user across all sessions
- No per-user isolation

**Mitigation**:
- Use in trusted environment only
- Plan for database-backed multi-tenancy

### Terminal Access

Terminal users have full agent-user access:
- Can read all files in `/workspace`
- Can execute commands as agent user
- Can install global packages

**Mitigation**:
- Warn users about shared container
- Plan for per-user containers

### Network ACL Bypass

Determined attacker could:
- Use public DNS to resolve internal IPs
- Use IPv6 if not blocked
- Exploit misconfigured ACLs

**Mitigation**:
- Block IPv6 if not needed
- Test ACLs with nmap/iptables
- Monitor network traffic

## Related Documentation

- [Provisioner Contract](../domain/provisioner-contract.md) - Security boundary
- [Multi-Tenant Control Plane](../domain/multi-tenant-control-plane.md) - Authorization
- [Configuration](configuration.md) - Security settings
- [Deployment](../workflows/deployment.md) - Hardening steps
