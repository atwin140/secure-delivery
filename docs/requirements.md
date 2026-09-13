# Build a browser-encrypted document delivery application on OpenShift

## Authority and completion

Build the complete application described below. Design the crypto envelope, API, schema and trust boundaries first, then implement incrementally with tests. Continue through all locally achievable work without routine clarification or approval questions. This is an implementation instruction, not another wayfinder interview.

Use the requirements below as fixed constraints. For remaining choices, select a conservative documented default using current primary documentation. Record the choice and rationale in `docs/decisions.md`; do not ask the user to choose libraries, formats or routine settings. Complete the protocol specification before implementing crypto. Do not improvise cryptographic primitives or claim an unreviewed format is audited.

When an unresolved constraint cannot safely be satisfied, finish independent work and record the exact blocker, attempted alternatives and required external action. Missing infrastructure or credentials must not stop local implementation: provide validated configuration templates, synthetic integration tests and an operator checklist. Report unrun checks honestly. Never invent credentials, disable security controls to make tests pass, claim production deployment without evidence, or claim tests prove absolute zero exposure. A mandatory independent security review is not a release gate.

Deliver working code, container images/build definitions, OpenShift manifests, deployment scripts, CI/CD example, admin/user documentation and a requirement-to-test evidence matrix. No core-feature placeholders. Production rollout and live email tests require an explicitly authorized environment; this prompt authorizes building and local testing, not unsolicited live messages or production changes.

## Product and trust boundary

One tenant per deployment and namespace. One repository means one immutable document delivery. A sender authenticates with Keycloak. A recipient has no account and accesses an unguessable URL, imports or pastes a portable key bundle, enters its password, and decrypts locally in the browser.

All document encryption/decryption, key generation and bundle wrapping/unwrapping happen in the browser. The application server never receives plaintext documents, plaintext internal metadata, document keys, bundle passwords or portable key bundles. The bundle and password are distributed out of band. There is no recovery, administrator decryption or offline decryptor.

Trust the delivered browser application. Protection against a compromised server actively delivering malicious client code, compromised recipient devices, and revocation of already downloaded copies is outside this version's security claim. Document these boundaries clearly.

Store exactly one encrypted object per finalized repository. The package contains every file plus encrypted filenames, MIME types, file count and individual sizes. Server-visible data is limited to total ciphertext size, opaque identifiers, lifecycle metadata and authorized sender identity. Avoid plaintext-derived object names, hashes and labels.

The browser must retrieve and verify the entire package before enabling downloads. Reject tampering, truncation, malformed internal structure and trailing data. Then offer individual plaintext files and Download all as a decrypted ZIP. All plaintext output is produced locally.

## Approved crypto starting profile

- Browser-CSPRNG-generated 32-byte repository key, fresh for every delivery including retries after a failed delivery.
- One libsodium `crypto_secretstream_xchacha20poly1305` stream for the entire package, with 1 MiB plaintext records independent of file boundaries. Use library-managed nonces/rekeying, a mandatory final tag and strict framing.
- Bundle KDF: `crypto_pwhash_ALG_ARGON2ID13`, `opslimit=3`, `memlimit=67108864`, fresh random 16-byte salt, 32-byte derived output. These are libsodium API parameters, not a claim to implement RFC 9106's four-lane profile.
- Wrap the repository key using XChaCha20-Poly1305 with a fresh random 24-byte nonce. Specify domain separation, authenticated header encoding, repository binding and key commitment using current libsodium guidance before implementation; include test vectors and negative tests.
- Suggested password: 20 random bytes encoded as 27 unpadded base64url characters. Permit custom passwords of at least 15 Unicode code points. Default to NFC normalization and UTF-8 encoding consistently at creation/unlock, with a 1024-byte normalized maximum; preserve spaces and case. Explain normalization briefly in technical documentation. Permit paste and password managers. A local weak-password warning may advise without changing the 15-character rule; no external password-check service.
- Version the complete format and fix its parameters per version. Define byte order, canonical authenticated encoding, lengths, allowed values and limits. Bound and validate bundle inputs before expensive KDF work. Reject unsupported versions/parameters; no silent downgrade. Crypto parameters are protocol settings, not tenant ConfigMap overrides.
- Pin dependency artifacts and lockfiles after checking current supported versions. Bundle browser crypto locally; no third-party script/CDN dependency on crypto screens.

Benchmark the profile before declaring support, targeting approximately 1–2 seconds for unlock on supported desktop hardware. Treat this as a target, not a measured promise. If the profile cannot meet the supported environment, record a concrete incompatibility rather than weakening it silently.

## Browser implementation and limits

Default stack: TypeScript throughout, Node.js current LTS, React/Vite browser UI and Fastify API. Prefer maintained dependencies with small, explicit interfaces. Default primary support is current stable desktop Chrome and Edge; test and document Firefox/Safari compatibility separately rather than claiming it. Ensure unsupported browsers receive a useful explanation.

Limits: 100 files, 250 MiB per file, 1 GiB total plaintext per delivery. Enforce internal limits locally because the server cannot inspect them. Separately enforce a documented maximum ciphertext size, calculated from bounded package metadata/framing overhead rather than trusting a client-supplied count.

Run crypto in a dedicated worker with bounded buffers and backpressure. Verify the complete package without retaining the entire plaintext in memory. Prefer temporary local ciphertext storage, then re-read and decrypt verified ciphertext for output; retain only necessary manifest data in memory. Do not stage plaintext in IndexedDB/OPFS. Ensure the bytes later decrypted correspond to the verified package, and handle quota exhaustion, cancellation, tab closure and cleanup. Document that browser-local ciphertext already obtained is a downloaded copy beyond server revocation. Do not claim perfect browser memory erasure.

Choose a bounded, versioned internal package representation; avoid unnecessary compression. Validate paths, duplicates, file lengths and archive structure. Generate a safe ZIP for Download all. Benchmark full-size individual and all-file outputs, not just the encryption primitive. If platform limitations prevent the agreed workflow, report them accurately while completing other work.

## Lifecycle, access and storage

Use ODF S3-compatible storage for ciphertext and one in-namespace Postgres instance on block storage for metadata/audit. Use the generic label S3 storage class in configuration/docs, distinguishing bucket provisioning from AWS object storage tiers. Verify the actual ODF gateway's capabilities through deploy-time checks; do not assume AWS lifecycle parity.

Finalization is atomic and occurs only after a complete successful upload. It locks the package and sets expiry to seven days later using server time. Sender can list their own deliveries by creation/expiry/status and revoke them early. Server listings cannot expose file counts or filenames.

Use bounded upload retries, default three retries with exponential backoff. Retry only identical ciphertext bytes idempotently. Exhausted retries invalidate the entire delivery; cleanup and retry with a fresh repository/key. Sixty minutes without upload activity means abandonment. Deny retrieval of pending/failed/abandoned deliveries.

Proxy ciphertext retrieval through the application with a private bucket; no recipient-facing S3 presigned download grants. Default recipient capability: 32 random bytes, URL fragment transport into browser memory, then an authorization header. Store only a verifier hash server-side and separate it from operational IDs. Keep it out of URLs sent to the backend, logs, analytics and persistent browser storage. Use no-referrer and no-store responses. Ensure email creation and sender link presentation do not require unsafe capability persistence; document any explicit link reissue semantics.

Check status and expiry on every retrieval. Default strict access policy: stop ongoing server streams at expiry and on revocation; implement/test propagation across running instances, cancellation and failure handling. Deny on uncertain authorization state. Downloaded browser-local copies remain outside this control.

Delete failed, abandoned, revoked and expired ciphertext within 24 hours of invalidation, with idempotent retries, orphan/multipart cleanup, monitoring and evidence of absence. Exclude document buckets from backups, retained object versions, retention locks and replication that preserves deleted versions. Deploy-time verification must surface incompatible storage configurations.

Metadata backups: daily logical backups retained 30 days, separate from the document bucket. Document the resulting up-to-24-hour RPO and measured restore procedure; do not claim HA for a single Postgres instance. Safe restore default: disable retrieval, invalidate every delivery recovered from backup, reconcile/delete remaining document objects, and require senders to recreate deliveries. This deliberately avoids resurrecting revocations absent from the backup. Restore audit history honestly, including possible loss since the last backup.

## Identity, configuration and infrastructure credentials

Use a server-session/BFF Keycloak OIDC authorization-code flow with PKCE, secure HttpOnly SameSite cookies, CSRF protection and strict issuer/audience validation. Configure one required client role and its client identifier through ConfigMaps; default role `repository-sender`. Enforce role and ownership server-side. Provide exact redirect/origin configuration instructions.

All non-confidential tenant, URL, Graph mailbox, integration and branding settings are runtime ConfigMaps; updates may require rollout but never image rebuilds. Expose only an explicit public configuration allowlist to the browser. Validate configuration and fail closed on missing required security settings.

Infrastructure credentials are allowed, document keys are not. Reference existing Kubernetes Secrets for Postgres, S3, OIDC and Graph; provide templates with placeholders only, plus rotation instructions. Keep secrets out of images, repository, ConfigMaps, logs and command examples. Production values are supplied by operators through their approved process. Local test credentials must be synthetic, clearly development-only and never accepted as production defaults.

Microsoft 365 Graph sends only generic repository-link emails with expiry. Sender enters addresses transiently; do not persist addresses in application data, audit, logs or queues. Default a dedicated mailbox with scoped application Mail.Send permissions; verify effective scope and avoid additive broad grants. Disable Sent Items saving where supported, while documenting external mail-system retention. A send failure leaves the delivery intact and supports explicit retry; an accepted response is not proof of delivery. No keys, bundles, passwords or internal file metadata in email.

## Audit, UI and platform security

Audit allowlist: opaque repository ID, event type, timestamp, outcome and sender ID on authenticated sender actions. Default audit retention 90 days, configurable; document that records may remain in retained backups afterward. Record ciphertext retrieval, never assert the recipient read a document. Redact bodies, capability-bearing paths/headers, cookies, authorization data, database parameters and provider errors across application and deployment logging. Verify operator-controlled ingress/storage logs separately.

Target WCAG 2.2 AA: keyboard operation, focus management, accessible errors/progress, contrast and automated plus manual checks. Modern understated dark theme with restrained red accents/errors. Generic configurable branding, no assumed business-specific content. Display Client-side encryption active only when crypto initialized and the described operation is actually client-side; show verification progress and keep downloads disabled until complete verification.

Use OpenShift restricted non-root execution with arbitrary namespace UIDs, minimal capabilities, no privilege escalation, RuntimeDefault seccomp, read-only root filesystem where practical, minimal service-account RBAC and explicit writable volumes. Include resource requests/limits and default-deny NetworkPolicies with required ingress/egress allowances. Document external egress-policy prerequisites.

Verified TLS on every network hop, including router-to-app, database, S3, Keycloak and Graph. Provide re-encrypt Route configuration and CA trust setup. Never use insecure TLS verification flags in production. Include restrictive CSP and browser security headers. Avoid rendering uploaded active content or server-side file previews.

## Work sequence and acceptance

1. Write the complete protocol, API, schema, state machine, threat model and trust-boundary/data-flow documents. Every persisted field and outbound request must have a purpose and sensitivity classification. Resolve technical details using primary sources and record rationale.
2. Implement and test the browser crypto/package layer with golden fixtures, cross-implementation primitive checks where feasible, malformed input tests and full-package verification. Prototype the supported browser memory/output strategy at the agreed limits.
3. Implement API, persistence, identity, ciphertext transport, lifecycle workers, link email and UI in tested increments. Use local service doubles only where necessary and label what they cannot establish.
4. Create containers, manifests, configuration/Secret templates, migration and deployment scripts, backup/restore and rotation procedures, plus a CI/CD example with no embedded credentials. Provide a reproducible local startup and test command.
5. Run available checks and fix failures. Map every requirement to code/docs and verification evidence. Include:
   - synthetic plaintext, filename, password and key canaries inspected in requests, database, object storage and logs, including errors;
   - wrong password/key, modified header/manifest/record, truncation/reordering/duplication/trailing data, oversized bundle/KDF inputs;
   - no individual or ZIP download before full-package validation, including late corruption;
   - ownership/role enforcement, capability leakage and recipient isolation;
   - finalization/upload races, retry exhaustion, abandonment, expiry, active-stream revocation and cleanup outages;
   - restore unable to resurrect old deliveries, object-version/multipart checks;
   - browser memory/backpressure/output limits, accessibility and TLS/network-policy checks where the environment supports them.
6. Deliver admin/user docs, architecture diagrams, threat model, SOC 2 control-to-evidence mapping (not a certification claim), dependency/SBOM information and exact completion status. Separate implemented-and-tested work from cluster/provider checks not run. List external prerequisites once in a precise operator checklist rather than stopping repeatedly to ask for them.

The final response must state what runs, how to run it, tests actually executed, remaining blockers and artifact locations. Continue until all feasible implementation and verification work is complete; do not stop at scaffolding or a plan.
