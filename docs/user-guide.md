# User guide

## Sender

1. Open the service in current desktop Chrome or Edge, in a normal browser profile with enough disk space. Sign in through your organization. You need its configured sender role.
2. Select 1–100 files. Each may be up to 250 MiB, with a 1 GiB total. Names must be safe basenames without folders, duplicate names or operating-system reserved names. The browser rejects unsupported names before uploading.
3. Save the generated 27-character password somewhere appropriate. You may replace it with at least 15 Unicode characters. Spaces and case count; do not trim them. Unicode is normalized consistently. The service cannot recover this password, the bundle or the files.
4. Select **Encrypt and create delivery**. Leave the tab open while the browser encrypts and uploads. Up to three retries follow the initial upload; retries reuse exactly the same ciphertext. An exhausted/failed delivery must be recreated, with a new repository and key.
5. After finalization, save the portable key bundle. Share the link, bundle and password through appropriately separate channels. The optional email form sends only a generic link and expiry, never the bundle, password or filenames. The addresses are not saved by this application. The mail provider may retain its own records.
6. The delivery expires seven days after finalization. Your list contains opaque IDs and lifecycle information only; use Load older deliveries for earlier pages. **Revoke** ends server access early; **Reissue link** creates a new capability and immediately invalidates every previous link. Reissue keeps the same bundle, password and expiry. Losing the displayed link requires reissue because its raw capability is not stored on the server.

An email acceptance message means Graph accepted the request, not that the recipient received or read it. An email error leaves the repository intact; retry explicitly. Browser refresh/navigation loses displayed link and key material. The 15-minute sender session can expire; sign in again to list/revoke/reissue. Large transfers interrupted by session expiration may need recreation.

## Recipient

1. Open the link in a supported desktop browser. No account is required. The URL fragment is immediately removed from the address bar and held in memory. Refreshing after that removal requires reopening the original link.
2. Paste the portable bundle or import its `.sdb` file, then enter its password. Paste and password managers are permitted.
3. Choose **Retrieve and verify**. The browser retrieves the complete ciphertext package and verifies every record and all internal structure. No individual file or ZIP download is enabled early.
4. After verification, use **Save file** or **Download all as ZIP**, choosing a destination in the native Save dialog. The browser decrypts the verified ciphertext again and streams the output directly to that destination. It does not preview or execute any uploaded content.
5. **Remove local ciphertext** removes the temporary encrypted copy. Closing or crashing a tab can leave ciphertext until the next visit's cleanup or until site data is cleared. Already saved plaintext remains wherever you chose to save it.

## Errors and limitations

- A wrong password, bundle mismatch, altered/truncated package or expired/revoked capability causes rejection. Obtain corrected access from the sender; administrators cannot decrypt or recover the documents.
- On quota exhaustion, free disk/site storage, use a normal profile and retry. A 1 GiB run in the private Chrome test context failed with a quota error. Storage estimates are advisory: a browser may reject a later write. Cancellation aborts the worker/output; cleanup retries at the next visit.
- Firefox/Safari and mobile browsers have not been declared compatible. The page explains missing required features. Edge remains a target pending its own measured environment check.
- Revocation stops future server access and active server streams as authorization checks propagate. It cannot recall bytes already delivered, local ciphertext, plaintext, screenshots or forwarded copies.
- The delivered application, browser and device are trusted. A compromised server serving malicious JavaScript, compromised recipient device or browser extension can defeat this protection. JavaScript memory cannot be perfectly erased.
