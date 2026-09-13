# Primary-source implementation research

Research date: 2026-09-12. This note records upstream facts and conservative implementation inferences; it is not an audit or evidence that a particular deployment has passed its checks. Protocol decisions are fixed in `protocol.md` and `decisions.md`; dependency artifacts and integrity hashes are fixed in the lockfile.

## Browser cryptography

### Secretstream and framing

Libsodium secretstream authenticates an ordered sequence, manages nonces and rekeying, and supports associated data on each message. Its usual stream uses `TAG_MESSAGE` and exactly one terminating `TAG_FINAL`. The library does not supply the application's external record framing or package parser. Therefore the application must require a final tag, reject EOF before it, reject data after it, and reject unwanted tag types. One stream across the whole package is consistent with the API. [Libsodium secretstream documentation](https://doc.libsodium.org/secret-key_cryptography/secretstream)

The public header is 24 bytes; key size is 32 bytes; each record adds 17 bytes. Tag values are MESSAGE=0, PUSH=1, REKEY=2, FINAL=3. These constants must be asserted against the bundled library during initialization and fixture tests. The proposed profile uses only MESSAGE and FINAL, while permitting the library's implicit internal rekeying. [Secretstream header definitions](https://raw.githubusercontent.com/jedisct1/libsodium/master/src/libsodium/include/sodium/crypto_secretstream_xchacha20poly1305.h), [XChaCha20-Poly1305 dimensions](https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction)

Implementation inference: fixed 1 MiB plaintext records, independent of file boundaries, simplify bounds and parsing. Authenticate the canonical public envelope and fixed-width record index/length as associated data. Authenticate all internal metadata within the stream. A successfully authenticated prefix is not a successfully verified delivery; release no plaintext downloads until the mandatory final record, declared lengths, full package structure, and EOF all agree.

### Bundle wrapping and commitment

Current libsodium guidance warns that ChaCha20-Poly1305 families do not inherently provide key commitment. Its documented transform is to prepend a keyed hash over nonce and ciphertext authentication tag and verify it before decrypting. If associated data is attacker-controlled, include it in the hash input as well. The docs specifically permit `crypto_auth()` and `crypto_auth_verify()` for this check. [Libsodium AEAD robustness guidance](https://doc.libsodium.org/secret-key_cryptography/aead#robustness)

Implementation inference following that transform:

1. Derive the 32-byte wrapping key from the fixed Argon2id output using the frozen `crypto_kdf` context and subkey ID.
2. Encode a fixed-length binary authenticated header containing format/version, fixed KDF identifiers/parameters, salt, nonce, and repository binding. Reject alternate encodings, unsupported parameters, reserved bits, length changes, and trailing bytes before the KDF.
3. Wrap exactly the 32-byte repository key with XChaCha20-Poly1305 combined mode, the header as associated data, and a fresh 24-byte nonce.
4. Compute `crypto_auth(nonce || final_16_byte_AEAD_tag || canonical_header, wrapping_key)`; store the commitment separately from the 48-byte wrapped key.
5. At unlock, derive that same key, verify the commitment first, then perform AEAD decryption and verify the repository binding. Show one generic password/bundle failure to users.

The transform uses the **same wrapping key** in the cipher and commitment as described upstream. Arbitrarily replacing this with a separate unrelated MAC key would be a different construction and should not be attributed to that recommendation. `crypto_auth` currently selects HMAC-SHA-512/256; lock the primitive and expected dimensions in format tests rather than infer them from a future default. [Libsodium crypto_auth public API](https://raw.githubusercontent.com/jedisct1/libsodium/master/src/libsodium/include/sodium/crypto_auth.h)

Repository binding protects against accidentally using a bundle for a different repository. The envelope is an application format assembled from documented primitives and still requires adversarial tests; it is not an audited cryptographic protocol.

### KDF domain separation and password parameters

`crypto_kdf_derive_from_key` derives subkeys from a 32-byte master key using a numeric subkey ID and an **exactly eight-byte** context. The context is public and intended to separate purposes. Subkey lengths between 16 and 64 bytes are supported. Use distinct fixed ASCII contexts for repository stream derivation and password-derived wrapping; specify their byte values and subkey IDs in the format, never a tenant override. [Libsodium key derivation](https://doc.libsodium.org/key_derivation)

`crypto_pwhash` takes `memlimit` in **bytes** and `opslimit` as its computation parameter. `ALG_DEFAULT` can change, so this format must explicitly pass `crypto_pwhash_ALG_ARGON2ID13`. Upstream recommends measuring the selected memory setting with opslimit 3. Allocation failure is a hard failure, not permission to retry with lower parameters. [Libsodium pwhash API](https://doc.libsodium.org/password_hashing/default_phf)

The public constants identify Argon2id 1.3 with value 2 and a 16-byte salt. The required format fixes output=32, opslimit=3, memlimit=67,108,864 and random salt=16; this is a libsodium API profile, not RFC 9106's four-lane profile. Upstream INTERACTIVE is opslimit 2, so do not substitute the INTERACTIVE constant for the user's required 3. [Argon2id constants](https://raw.githubusercontent.com/jedisct1/libsodium/master/src/libsodium/include/sodium/crypto_pwhash_argon2id.h)

The JavaScript wrapper accepts a byte buffer password, enabling explicit NFC normalization and UTF-8 conversion before calling sodium. Its call parameters match key length, password, salt, opslimit, memlimit, and algorithm. [Wrapper source](https://github.com/jedisct1/libsodium.js/blob/master/wrapper/symbols/crypto_pwhash.json)

Implementation inference: reject malformed Unicode, normalize to NFC, count code points after normalization, preserve spaces/case, require at least 15 code points and at most 1024 UTF-8 bytes. Generated 20-byte random base64url passwords avoid Unicode ambiguity. Benchmark the frozen parameters inside the actual production crypto worker; a native or Node benchmark alone cannot declare browser support.

## Supported dependency lines

These observations are from current upstream pages. They identify versions to resolve and test, not permission to fabricate an unavailable registry artifact. Build-time registry resolution must agree with the artifact actually installed. Pins must be revisited for security updates.

| Component     | Primary-source observation                                                                                                                                                                                                                 | Conservative choice                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Node.js       | Node 24 is latest LTS; 26 is Current; the official distribution index lists 24.21.0 dated September 7, 2026. [Release policy](https://nodejs.org/en/about/previous-releases), [distribution index](https://nodejs.org/dist/index.json)     | Node 24 LTS, exact available patch pinned in runtime/build metadata; do not select Current merely for its greater version number. |
| libsodium.js  | Upstream releases list 0.8.4 as latest; 0.8.3 updated to libsodium 1.0.22. [Releases](https://github.com/jedisct1/libsodium.js/releases)                                                                                                   | Resolve/pin `libsodium-wrappers-sumo` and `libsodium-sumo` together, and test the required functions after `sodium.ready`.        |
| Fastify       | Latest documentation points to 5.12.1; v5 is the supported line and its policy follows supported Node LTS lines. [Latest docs](https://fastify.dev/docs/latest/), [LTS policy](https://fastify.dev/docs/latest/Reference/LTS/)             | Fastify v5 current available patch, matching plugin majors.                                                                       |
| Vite          | Regular fixes target 8.3; 8.2/7.3 get important/security fixes; 8.1/6.4 security fixes. Earlier ranges are unsupported. [Release policy](https://vite.dev/releases)                                                                        | Current supported available patch; record explicitly if registry access forces a supported older line.                            |
| React         | Official versions page lists 19.3.0 released September 9, 2026. [Versions](https://react.dev/versions)                                                                                                                                     | Match exact React/React DOM versions. No server components are needed for this client-only SPA.                                   |
| openid-client | 6.8.7 is latest upstream release; v6 is supported, with WebCrypto/Fetch and Node 20 baseline. [Releases](https://github.com/panva/openid-client/releases), [supported runtimes](https://github.com/panva/openid-client#supported-runtimes) | v6 ESM on Node 24; use the maintained flow/validation API instead of custom OIDC parsing.                                         |

Browser crypto must be served from the application origin. The wrapper exposes a readiness promise that must finish before cryptographic APIs are used. Its general browser compatibility list does not prove this application's OPFS, file-output, memory, or accessibility behavior. [libsodium.js usage and packaging](https://github.com/jedisct1/libsodium.js/)

## Keycloak and BFF validation

OAuth security best practice recommends PKCE even for confidential clients. Use authorization code with `S256`, state, nonce, a server-side one-time transaction, and a confidential client. Do not use implicit or resource-owner-password grants. [RFC 9700, authorization code flow protection](https://datatracker.ietf.org/doc/html/rfc9700#section-2.1.1)

`openid-client.authorizationCodeGrant` accepts `expectedState`, `expectedNonce`, `pkceCodeVerifier`, and `idTokenExpected`. Set them from the stored transaction and consume the transaction before exchange. Never use its skip-validation symbols in production. [AuthorizationCodeGrantChecks API](https://github.com/panva/openid-client/blob/main/docs/interfaces/AuthorizationCodeGrantChecks.md), [upstream one-time state handling](https://github.com/panva/openid-client/blob/main/src/passport.ts)

OIDC requires issuer equality and a valid client-ID audience; reject untrusted additional audiences, invalid authorized-party claims, expired tokens, wrong nonce, and signature/algorithm failures. Identify a sender by `iss` plus `sub`, never email or display name. Discovery starts only from the configured HTTPS issuer; callback construction starts from the configured public origin, not an untrusted Host header. [OIDC Core ID token validation and identity stability](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)

Keycloak settings: client authentication ON; Standard Flow ON; direct grants/implicit/service-account flows OFF unless separately needed; PKCE method S256; exact HTTPS callback in Valid Redirect URIs; no wildcard; explicit application origin if Web Origins is set. A BFF does not need browser CORS calls to Keycloak. Client roles default to access-token/introspection claims, **not ID tokens**. To authorize from the validated ID token, add a narrow client-role mapper with Add to ID token ON and claim `resource_access.<role-client>.roles`, disable Full Scope Allowed, and restrict role scope mappings. Alternatively validate an access token separately against its configured audience; the BFF client is not automatically present in access-token `aud`. [Keycloak client configuration, role mapping, audience](https://www.keycloak.org/docs/latest/server_admin/index.html#_oidc_clients)

Implementation inference: keep tokens and callback transaction secrets server-side, issue only an opaque Secure/HttpOnly/SameSite=Lax session cookie, rotate the session identifier after login, bound session lifetime, and require CSRF tokens plus exact Origin checks on authenticated mutations. Re-check required role and ownership on every sender action; the recipient capability has no sender privileges.

## Microsoft Graph email scope and privacy

Graph `POST /users/{id-or-UPN}/sendMail` supports application `Mail.Send`. Use JSON with boolean `saveToSentItems: false` (default is true). A `202 Accepted` has no response body and does not establish completed processing or delivery. Never create drafts or queue recipients in application storage merely to retry a failed call. [Graph sendMail API](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0)

Exchange Application RBAC can scope `Application Mail.Send` to a dedicated mailbox; it replaces Application Access Policies. Register the correct enterprise service-principal object, create a narrow management scope, and assign that role. Entra grants and Exchange RBAC grants are **additive**; remove broad Entra Mail.Send permissions. `Test-ServicePrincipalAuthorization -Resource` checks the selected mailbox but excludes separate Entra grants. Audit those grants separately, and check an authorized and unauthorized mailbox. Permission caches can last 30 minutes to two hours; the test cmdlet bypasses them. [Exchange Application RBAC configuration and limitations](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)

Implementation inference: transiently accept recipients and the current fragment capability over an authenticated CSRF-protected API call only to construct the generic link email. Persist neither; redact bodies/provider errors. Use the configured dedicated mailbox as the only Graph send path. Send errors leave the repository intact. Explicit user retry may duplicate a message if the provider accepted an earlier request before a connection failure. Operator retention, journaling, transport logs, recipient copies, and other external mail-system retention remain outside `saveToSentItems` control. Live positive/negative mail tests require an expressly authorized environment.

## ODF S3 deletion and capability verification

ODF 4.21 documents both MCG/NooBaa and RGW endpoints, object versioning and lifecycle operations. It supports replication configured on OBCs and BucketClasses. Its version-replication section says old versions can be replicated and deletion of particular version IDs is not replicated. Therefore S3-level replication inspection alone cannot prove no retained copies. [ODF 4.21 hybrid and multicloud resource management](https://docs.redhat.com/en/documentation/red_hat_openshift_data_foundation/4.21/html-single/managing_hybrid_and_multicloud_resources/managing_hybrid_and_multicloud_resources)

ODF lifecycle documentation distinguishes permanently deleting nonversioned objects from moving versioned objects into noncurrent history. It also documents cleanup of noncurrent versions and incomplete multipart uploads. A lifecycle rule is useful defense in depth but does not prove this application's 24-hour deletion deadline on an untested gateway. [ODF lifecycle rules](https://docs.redhat.com/en/documentation/red_hat_openshift_data_foundation/4.19/html/managing_hybrid_and_multicloud_resources/creating-and-managing-buckets-using-mcg-object-browser_rhodf#creating-new-lifecycle-rules-using-mcg-object-browser_rhodf)

Deployment inference: label configuration **S3 storage class** for the operator's bucket provisioner; distinguish it from an AWS object-tier header. Use a private, dedicated, never-versioned bucket. A Suspended versioning response does not establish absence of older versions. Require no object lock, retention, replication, backups, namespace caching, or underlying replicas that preserve deleted objects. Inspect OBC, BucketClass, BackingStore/NamespaceStore and provider settings with operator privileges, not application-admin bucket credentials.

Deploy-time evidence should include:

1. Verified HTTPS with the actual CA chain/hostname; never inherit `--no-verify-ssl` examples.
2. Gateway identity/version, bucket provisioning class, bucket ownership and anonymous GET denial.
3. Read-back of versioning, object-lock, lifecycle and replication state. Distinguish a documented unsupported API from authorization denial; ambiguous results fail closed pending operator evidence.
4. A random opaque probe: PUT, exact GET/HEAD length, DELETE, then absence through HEAD and paginated object/version listings.
5. A multipart probe: create, upload a bounded part, list, abort, and show absence in paginated upload listings.
6. Operator inspection proving no ODF-level or backing-store retention/replication/backup policy.
7. An outage exercise showing idempotent cleanup retries, oldest pending deletion age alerts, orphan reconciliation, and final evidence of absence within 24 hours.

The probe demonstrates API behavior for sampled objects at that time; it cannot prove physical media erasure or all future configuration. A cluster configuration change requires renewed checks.

## Evidence still requiring the implementation or environment

This research did not install dependency artifacts, execute crypto, contact a tenant identity provider, send email, or access a storage cluster. Direct web-tool opens of npm registry metadata returned errors; package-manager resolution is needed to establish available artifact versions and lockfile integrity. Browser unlock/full-size output timing, worker peak memory/backpressure, OPFS quota/cancellation cleanup, independent primitive fixtures, OIDC failure cases, multi-instance revocation, actual ODF deletion behavior, TLS/network policy, restore timing, and accessibility must be reported from executed checks rather than inferred from upstream documentation.
