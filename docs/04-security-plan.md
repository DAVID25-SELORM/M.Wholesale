# 4. Security Plan

Assets to protect, in priority order: (1) integrity of stock and financial records, (2) tenant data confidentiality (customer lists, prices, margins), (3) availability during trading hours, (4) personal data of staff/contacts, (5) regulatory evidence (licences, controlled-drug register).

## 4.1 Threat model (STRIDE summary)

| Threat | Example | Primary controls |
|--------|---------|------------------|
| Spoofing | Stolen password, credential stuffing | Argon2id, MFA, rate limit, breached-password check, device/session mgmt |
| Tampering | Staff edits invoice/stock to hide theft | Immutable posted docs, append-only ledger, audit log, separation of duties, DB triggers |
| Repudiation | "I didn't approve that discount" | Signed audit events (user, time, IP, device, before/after), approval records |
| Information disclosure | Tenant A sees tenant B; mass export by leaver | RLS, composite FKs, export permissions + logging, field masking, DLP-style export limits |
| Denial of service | API flood during peak, heavy report locks DB | Rate limits, WAF, report queue + replica, timeouts, autoscaling |
| Elevation of privilege | Cashier calls admin API | Server-side RBAC on every route, deny-by-default, permission tests in CI |
| Insider fraud | Ghost customers, credit-limit games, fake adjustments | Approval workflows, maker-checker, anomaly alerts (large adjustments, round-tripping, after-hours edits), periodic access review |
| Supply chain | Malicious npm package | Lockfile, `pnpm audit`/Renovate, SBOM, pinned base images, provenance |

## 4.2 Authentication

- Email/phone + password; Argon2id (memory 64 MiB, t=3, p=1 tuned on hardware); min length 12, breached-password denylist, no composition theatre.
- **MFA**: TOTP (authenticator app) mandatory for owners, finance, admin and approver roles; optional for others; SMS OTP as fallback only (SIM-swap risk) — WebAuthn/passkeys planned.
- Short-lived access JWT (10–15 min) + rotating refresh token (httpOnly, Secure, SameSite=Lax cookie, reuse detection → revoke family). Server-side session table enables instant revocation.
- POS quick-switch: PIN (≥ 6 digits, lockout after 5 tries, bound to terminal) layered on an authenticated terminal session; PINs hashed.
- Account lockout with exponential backoff, generic error messages, login anomaly e-mail.
- SSO (OIDC/SAML) for larger tenants — phase 6.

## 4.3 Authorisation

- RBAC with permission strings `module.resource.action`; roles are bundles; user-role assignments are **scoped** (tenant / branch / warehouse).
- Enforced in a NestJS guard on every handler (deny by default; routes need an explicit `@Permission()` or `@Public()`), plus service-level checks for scope.
- Attribute rules on top: amount thresholds (discount %, credit override value, adjustment value), time windows, branch scope.
- **Separation of duties** matrix (configurable): creator ≠ approver; receiver of goods ≠ approver of supplier invoice; cash-up counter ≠ reconciler; adjuster ≠ approver.
- Sensitive actions require **step-up** re-authentication (password/TOTP) — e.g. changing credit limit, bank details, voiding posted docs, role changes, destroying stock.
- Quarterly access-review report (who has what) sent to owner.

## 4.4 Tenant isolation

- PostgreSQL RLS on every tenant table; app role without `BYPASSRLS`; `SET LOCAL app.tenant_id` per transaction; composite foreign keys.
- Automated leakage tests: for every table, assert a different-tenant context returns 0 rows and cannot insert/update across tenants. Table-without-policy check in CI (fails build).
- Object storage keys prefixed `tenant/{id}/…`; signed URLs short-lived (≤ 5 min), authorisation checked before signing.
- Caches/queues namespaced by tenant; background jobs carry `tenant_id` and re-establish context.
- Vendor staff access: no standing access; time-boxed, tenant-consented impersonation, fully audited, visible banner.

## 4.5 Data protection and privacy (Ghana Data Protection Act, 2012 — Act 843)

- Register with the Data Protection Commission as a data controller/processor (action item); appoint a data-protection contact.
- Data minimisation: no patient clinical data is required for wholesale. Avoid collecting patient identifiers; if prescription references are ever stored, treat as sensitive health data with stricter controls.
- Encryption: TLS 1.2+ (1.3 preferred), HSTS; AES-256 at rest (disk, backups, object storage); **application-level encryption** (envelope, KMS-managed keys) for bank account numbers, national IDs, MoMo numbers where stored, API credentials; per-tenant data keys as option for large tenants.
- Subject rights: export/erase/rectify procedures; erasure is pseudonymisation where law requires financial retention.
- Data residency: decision pending (doc 7); contractual DPAs with all sub-processors (cloud, SMS, e-mail, payment).
- Logs must not contain secrets, full card/MoMo numbers, passwords or tokens (log scrubbing + tests).

## 4.6 Application security

- OWASP ASVS Level 2 as the verification baseline; OWASP Top 10 mapped to controls.
- Input validation (Zod/class-validator) on all inputs, output encoding by React, parameterised SQL only (Prisma; raw queries via tagged templates), file upload validation (type sniffing, size caps, AV scan via ClamAV, no execution, re-encode images, store outside web root).
- CSRF: SameSite cookies + double-submit/`Origin` check; strict CORS allow-list; CSP (no inline script, nonce-based), `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`, Permissions-Policy.
- Rate limiting per IP, user and tenant; login and OTP endpoints stricter; bot protection on public forms.
- Excel import hardening: formula-injection neutralisation on export (prefix `'` for cells starting `= + - @`), zip-bomb and row-count limits, sandboxed parsing in worker.
- SSRF controls on any URL fetch (webhooks, imports): allow-list, block private ranges.
- Webhooks: HMAC signature + timestamp; replay window.
- Secrets in a secrets manager, rotated; no secrets in env files committed; separate keys per environment.
- Dependency & SAST: `pnpm audit`, Renovate, CodeQL/Semgrep, secret scanning (gitleaks) in CI; container scanning (Trivy); SBOM per release.
- Pen test before first production go-live and annually; bug-report contact (`security.txt`).

## 4.7 Audit and monitoring

- `audit_log` (append-only, partitioned): authentication events, permission denials, all create/update/void/approve/post on business documents and sensitive master data (price, cost, credit limit, bank details, roles), exports, impersonation, config changes. Stores actor, tenant, IP, device, request ID, before/after diff.
- Tamper evidence: hash-chain per tenant per day (each record includes hash of previous), daily digest stored in separate write-once bucket.
- Fraud/anomaly alerts: adjustments > threshold, repeated discount overrides by one user, voids after hours, credit limit changes followed by large sales, stock count variances by location, price below cost, duplicate supplier invoices, round-sum receipts.
- Central logging (structured), metrics, uptime checks, on-call alerting; security events to a SIEM-lite dashboard.

## 4.8 Backup, DR and business continuity

- PITR with WAL archiving (RPO ≤ 5 min); daily snapshots (35 days); monthly archive (7 years); backups encrypted, in a separate account/region with restricted delete (object lock).
- Restore drill quarterly with measured RTO; runbook documented.
- Multi-AZ database; stateless app tier; infrastructure as code (Terraform) so the environment can be rebuilt.
- Offline fallbacks: POS offline cash sales; downtime procedure (paper invoices with pre-printed batches) + back-entry flow.
- Tenant data export always available (even in suspended/cancelled state, for a defined window).

## 4.9 Secure SDLC

- Threat-model review per major feature; security acceptance criteria in tickets.
- Mandatory code review, branch protection, signed commits (when repo is hosted), CI gates: lint, types, unit/integration, RLS-coverage test, SAST, dependency audit, migration lint.
- Migrations reviewed for lock risk and RLS coverage; production access via break-glass with approvals and session recording.
- Staging uses synthetic/anonymised data only.

## 4.10 Incident response

1. Detect (alerts/reports) → 2. Triage & severity → 3. Contain (revoke sessions/keys, isolate tenant) → 4. Eradicate/recover → 5. Notify affected tenants and the Data Protection Commission as required by law (confirm timelines with counsel) → 6. Post-incident review with corrective actions. Documented runbooks, contact tree, annual tabletop exercise.

## 4.11 Compliance-oriented controls specific to pharma

- Controlled-drug register entries and recall actions are tamper-evident and non-deletable.
- Licence expiry (premises, supplier, customer) monitored; actions blocked per policy.
- Regulator-facing exports (inspection pack: licences, SOPs, batch traces, destruction certificates, temperature logs) generated on demand with a read-only **Inspector/Auditor** role.
- Electronic signatures on approvals meet "attributable, legible, contemporaneous, original, accurate" (ALCOA+) principles.
