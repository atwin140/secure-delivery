# Secure Delivery format 1

Status: application protocol, specified before implementation; not independently audited. All cryptography uses locally bundled libsodium. This format does not introduce a cryptographic primitive. No protocol setting is runtime configurable. Integers are unsigned big endian unless the ZIP section explicitly says otherwise. Concatenation is `||`. ASCII constants have exactly the bytes shown, without terminators. Every decoder rejects unknown versions, noncanonical encodings and trailing bytes.

## Identifiers and secrets

Repository ID: server-generated random 16 bytes, lowercase 32-character hex in APIs. Operational object key: the same random hex ID, never a filename or plaintext hash. Recipient capability: independent server CSPRNG 32 bytes, unpadded base64url (43 characters), SHA-256 verifier stored in Postgres. Link `/receive#r=<id>&c=<capability>` is consumed once into memory and immediately removed with replaceState; the backend sees only `/receive`. Retrieval uses `/api/recipient/<id>` and `Authorization: Bearer <capability>`. Neither bundle nor password appears in an application request. A fresh delivery ALWAYS generates a fresh browser CSPRNG repository key (32 bytes).

## Portable bundle

Text is `sdb1.` followed by canonical unpadded base64url of exactly 144 bytes, total 197 ASCII characters. An imported file is at most 197 bytes. No whitespace is stripped or permitted. Reject size, alphabet, version, repository mismatch and password bounds BEFORE Argon2 work.

Binary layout: magic `SDKEY001` (8), repository ID (16), salt (16), nonce (24), ciphertext/tag (48), commitment (32). The first 64 bytes are header H. Salt and nonce are independently random. The wrapped plaintext is exactly the 32-byte repository key. AAD is ASCII `SecureDelivery/Bundle/v1` || H. Password normalization: reject ill-formed UTF-16, normalize NFC, require at least 15 Unicode code points and at most 1024 UTF-8 bytes; preserve spaces and case. Raw input is capped at 4096 UTF-16 code units before normalization. Creation and unlock use identical rules. Suggested passwords encode 20 CSPRNG bytes in base64url, yielding 27 characters.

M = crypto_pwhash(32, UTF8(NFC(password)), salt, 3, 67108864, crypto_pwhash_ALG_ARGON2ID13). Derive W = crypto_kdf_derive_from_key(32, 1, `SDBNDL01`, M). Encrypt key with crypto_aead_xchacha20poly1305_ietf_encrypt, nonce and AAD. Commitment = crypto_auth(nonce || ciphertext_tag || AAD, W). Verify commitment with crypto_auth_verify BEFORE AEAD decrypt. This follows libsodium's robustness transform, including attacker-controlled AAD. The Argon2 API parameters do not describe RFC 9106's four-lane profile. Zero mutable temporary key/password buffers when possible; JavaScript strings and browser copies cannot be reliably erased.

## Encrypted package

Derive S = crypto_kdf_derive_from_key(32, 1, `SDPKG001`, repository key). Derive C = crypto_kdf_derive_from_key(32, 2, `SDPKG001`, repository key). Exactly ONE secretstream state encrypts the complete internal package. No per-file streams. Header H: `SDPKG001` (8), repository ID (16), libsodium-generated secretstream header (24), total 48 bytes. Do not generate stream nonces manually. Record i (zero-based) consists of ciphertext length L (u32), crypto_auth commitment (32), ciphertext including its 17-byte secretstream overhead (L). AAD = H || u32(i) || u32(L). Commitment = crypto_auth(secretstream_header || ciphertext || AAD, C), verified before secretstream pull. Secretstream authenticates the same AAD.

Fill records across file boundaries. Every non-final record has exactly 1,048,576 plaintext bytes, L=1,048,593 and TAG_MESSAGE. The final record has 0..1,048,575 plaintext bytes and TAG_FINAL, even when an empty final record is needed. Other tags are rejected. Final must be followed by EOF. Library-managed rekeying applies. Ordering, duplication, header changes, ciphertext changes, truncation, missing final and appended data fail closed.

## Internal package

Inside encryption: `SDFIL001` (8), file count (u16, 1..100), followed by exactly count entries. Each entry is name length (u16), name UTF-8 bytes (1..240), MIME length (u16), MIME ASCII bytes (1..127), size (u64). Then concatenate each file's exact bytes in manifest order. There is no compression, padding, directory entry, extension field or trailer. Size is 0..262,144,000 (250 MiB), total file bytes <=1,073,741,824 (1 GiB). Decode UTF-8 fatally and require NFC names. MIME must match `type/subtype` using the conservative ASCII token alphabet; unknown types become `application/octet-stream` at creation.

Names are basenames only. Reject `.`, `..`, separators `/` and `\`, colon, control characters, DEL, Windows-forbidden characters, trailing dot/space, reserved DOS device stems and bidi control characters. Reject duplicate names under NFC plus lowercasing, preventing common destination collisions. Names are bounded in bytes. No browser preview of any file type. Sender File objects supply bytes/size; stream length must match exactly. Internal decoding checks all lengths and total limits before processing payload, consumes exactly the declared bytes, then requires EOF.

Maximum manifest bytes = 10 + 100*(2+240+2+127+8) = 37,910. Maximum plaintext package P = 1,073,779,734. Number of records N = floor(P/1,048,576)+1 = 1025. Maximum ciphertext = 48 + P + 53*N = **1,073,834,107 bytes**. The API enforces this independently of any client file-count claim.

## Local verification and output

Dedicated worker encrypts bounded records into a unique, exclusively locked OPFS ciphertext file. It downloads ciphertext into another such file with a hard byte ceiling, then fully verifies the secretstream and internal structure while discarding file payload plaintext. Retain only bounded manifest and a SHA-256 ciphertext digest per record (<=1025\*32 bytes), header, key and total size. Verification failure destroys the temporary ciphertext and never enables output.

After verification, output re-reads the same locked ciphertext, checks each record's hash against the verified record BEFORE decrypting/outputting it, revalidates stream authentication and structure, and writes bounded chunks with awaited sink writes. Header and total length must also match. An output attempt aborts its destination on any failure. This prevents different bytes being decrypted later, without retaining package plaintext. Browser/OS compromise remains outside the trust boundary. All output handles are selected by the user; no plaintext is staged in OPFS or IndexedDB.

Download all emits a standard uncompressed ZIP32 (little endian per ZIP specification), UTF-8 names, fixed DOS timestamp 1980-01-01, data descriptors with CRC32 and exact lengths, central directory and EOCD. At these limits ZIP64 is unnecessary. CRC32 is only ZIP interoperability metadata, never security authentication. Individual and ZIP writes are committed only after successful traversal. Per-file names are sanitized before either output. File System Access API + OPFS + dedicated worker + WebAssembly + secure context are required. Current desktop Chrome/Edge are the target; feature failure gives an actionable unsupported-browser screen. Firefox/Safari support is not claimed.

Cancellation terminates the worker, releases locks, aborts uploads/sinks and removes known temporary files. Startup garbage collection removes unlocked `sd-` OPFS ciphertext files (Web Locks prevent deleting another active tab's file). A crash/tab closure may leave ciphertext until the next visit or site-data clearing. Browser-local ciphertext is already a downloaded copy and cannot be revoked remotely. No guarantee of perfect browser memory erasure.

## Protocol evidence

Tests contain frozen bundle/package fixtures and deterministic test inputs only; production randomness is never overridden. Primitive interoperability is checked with native libsodium when available. Tests include validly encrypted malformed internal packages, invalid bundle headers/lengths, wrong keys/passwords, late corruption and all framing failures. Benchmarks must record actual hardware/browser/runtime and size; the 1–2 second unlock figure is a target, not a promise. Sources and implementation choices: [decisions.md](decisions.md), [research.md](research.md).
