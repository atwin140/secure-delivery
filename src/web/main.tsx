import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Entry } from "../crypto/package";
import "./style.css";
import { Icon, PrivacyArtwork } from "./icons";
declare global {
  interface Window {
    showSaveFilePicker(options?: {
      suggestedName?: string;
    }): Promise<FileSystemFileHandle>;
  }
}
const fragment = new URLSearchParams(location.hash.slice(1));
const incoming = {
  repo: fragment.get("r") ?? "",
  capability: fragment.get("c") ?? "",
};
if (location.hash) history.replaceState(null, "", location.pathname);
fragment.delete("r");
fragment.delete("c");
const isRecipient = location.pathname === "/receive";
const formatBytes = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;
type Row = {
  id: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  ciphertext_bytes: string | null;
};
function App() {
  const [config, setConfig] = useState({
      brandName: "Docs signed by Sharkbait",
      supportText: "Contact your sender for access help.",
      development: false,
      emailEnabled: true,
    }),
    [session, setSession] = useState<{ id: string; csrf: string } | null>(null),
    [loaded, setLoaded] = useState(false),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [phase, setPhase] = useState(""),
    [progress, setProgress] = useState(0),
    [password, setPassword] = useState(""),
    [bundle, setBundle] = useState(""),
    [files, setFiles] = useState<File[]>([]),
    [entries, setEntries] = useState<Entry[]>([]),
    [rows, setRows] = useState<Row[]>([]),
    [delivery, setDelivery] = useState<{
      id: string;
      capability: string;
      expiresAt?: string;
    } | null>(null),
    [addresses, setAddresses] = useState(""),
    [more, setMore] = useState(false),
    [mailBusy, setMailBusy] = useState(false),
    [showPassword, setShowPassword] = useState(false);
  const worker = useRef<Worker | null>(null),
    generation = useRef(0),
    current = useRef<{ id: string; csrf: string } | null>(null),
    notice = useRef<HTMLDivElement>(null);
  const supported =
    window.isSecureContext &&
    !!window.showSaveFilePicker &&
    !!navigator.storage?.getDirectory &&
    !!navigator.locks &&
    !!window.Worker &&
    typeof WebAssembly !== "undefined";
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(path, {
      ...(body !== undefined
        ? {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": session?.csrf ?? "",
            },
            body: JSON.stringify(body),
          }
        : {}),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) {
      const json = await response.json().catch(() => ({}));
      throw new Error(json.error ?? "The request failed. Please try again.");
    }
    return response.json();
  };
  const refresh = async () => {
    try {
      const batch = await request("/api/repositories");
      setRows(batch);
      setMore(batch.length === 100);
    } catch {
      setSession(null);
    }
  };
  const startWorker = () => {
    worker.current?.terminate();
    setReady(false);
    const w = new Worker(new URL("./crypto.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    w.onmessage = (e) => {
      if (worker.current !== w) return;
      const data = e.data;
      if (data.type === "ready") {
        setReady(true);
        if (!isRecipient) setPassword(data.password);
      }
      if (data.type === "progress") {
        setPhase(data.phase);
        setProgress(
          data.total ? Math.min(100, (100 * data.bytes) / data.total) : 0,
        );
      }
      if (data.type === "error") {
        setBusy(false);
        setEntries([]);
        setBundle("");
        setError(data.message);
        if (current.current) {
          void fetch(`/api/repositories/${current.current.id}/fail`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": current.current.csrf,
            },
            body: "{}",
          });
          current.current = null;
        }
      }
      if (data.type === "sent") {
        setBusy(false);
        setBundle(data.bundle);
        setDelivery((d) => (d ? { ...d, expiresAt: data.expiresAt } : d));
        setMessage(
          "Delivery finalized. Save the bundle and share it separately from the link and password.",
        );
        current.current = null;
        void refresh();
      }
      if (data.type === "verified") {
        setBusy(false);
        setEntries(data.entries);
        setPassword("");
        setBundle("");
        setMessage(
          "The entire package is verified. You can now save your files.",
        );
      }
      if (data.type === "saved") {
        setBusy(false);
        setMessage("Verified files saved.");
      }
      if (data.type === "cleared") {
        setEntries([]);
        setMessage("Local ciphertext removed.");
      }
    };
    w.onerror = () => {
      setBusy(false);
      setError(
        "The encryption worker could not run. Use an up-to-date desktop Chrome or Edge browser.",
      );
      setReady(false);
    };
    w.postMessage({ type: "init" });
  };
  useEffect(() => {
    void fetch("/api/public-config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setError("Application configuration unavailable."));
    if (!isRecipient)
      void fetch("/api/session")
        .then(async (r) => {
          if (r.ok) setSession(await r.json());
        })
        .finally(() => setLoaded(true));
    else setLoaded(true);
    if (supported) startWorker();
    const leave = () => {
      if (current.current)
        void fetch(`/api/repositories/${current.current.id}/fail`, {
          method: "POST",
          keepalive: true,
          headers: {
            "content-type": "application/json",
            "x-csrf-token": current.current.csrf,
          },
          body: "{}",
        });
      worker.current?.terminate();
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, []);
  useEffect(() => {
    if (session) void refresh();
  }, [session?.id]);
  useEffect(() => {
    if (error || message) notice.current?.focus();
  }, [error, message]);
  useEffect(() => {
    document.title = config.brandName;
  }, [config.brandName]);
  const clearNotice = () => {
    setError("");
    setMessage("");
  };
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    clearNotice();
    if (!session || !files.length) return;
    const run = ++generation.current;
    setBusy(true);
    setBundle("");
    setDelivery(null);
    try {
      const created = await request("/api/repositories", {});
      if (run !== generation.current) {
        await request(`/api/repositories/${created.id}/fail`, {}).catch(
          () => {},
        );
        return;
      }
      setDelivery(created);
      current.current = { id: created.id, csrf: session.csrf };
      worker.current?.postMessage({
        type: "send",
        repo: created.id,
        files,
        password,
        csrf: session.csrf,
      });
    } catch (e) {
      if (run !== generation.current) return;
      setBusy(false);
      setError((e as Error).message);
    }
  };
  const receive = (e: React.FormEvent) => {
    e.preventDefault();
    clearNotice();
    setBusy(true);
    setEntries([]);
    worker.current?.postMessage({
      type: "receive",
      ...incoming,
      bundle,
      password,
    });
  };
  const cancel = () => {
    generation.current++;
    worker.current?.terminate();
    if (current.current)
      void request(`/api/repositories/${current.current.id}/fail`, {}).catch(
        () => {},
      );
    current.current = null;
    setBusy(false);
    setEntries([]);
    setBundle("");
    setDelivery(null);
    setMessage("Cancelled. Temporary ciphertext will be cleaned up.");
    startWorker();
  };
  const save = async (index: number) => {
    const run = ++generation.current;
    clearNotice();
    setBusy(true);
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: index === -1 ? "delivery.zip" : entries[index].name,
      });
      if (run !== generation.current) return;
      setBusy(true);
      worker.current?.postMessage({ type: "output", index, handle });
    } catch (e) {
      setBusy(false);
      if ((e as Error).name !== "AbortError")
        setError("Unable to select the output file.");
    }
  };
  const downloadBundle = () => {
    const url = URL.createObjectURL(
      new Blob([bundle], { type: "application/octet-stream" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "delivery.sdb";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const action = async (row: Row, action: "revoke" | "reissue") => {
    clearNotice();
    try {
      const result = await request(`/api/repositories/${row.id}/${action}`, {});
      if (action === "reissue") {
        setDelivery({
          id: row.id,
          capability: result.capability,
          expiresAt: row.expires_at ?? undefined,
        });
        setBundle("");
        setMessage(
          "New link created. Every previous link now stops working. The existing bundle and password still apply.",
        );
      } else {
        if (delivery?.id === row.id) setDelivery(null);
        setMessage(
          "Delivery revoked. Previously downloaded copies remain available to their holders.",
        );
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <header>
        <a href="/" className="brand">
          <span className="mark" aria-hidden="true">
            <Icon name="document" />
          </span>
          {config.brandName === "Docs signed by Sharkbait" ? (
            <span className="wordmark">
              Docs <span>signed by Sharkbait</span>
            </span>
          ) : (
            config.brandName
          )}
        </a>
        <span className="mode">
          {isRecipient ? "Recipient access" : "Sender workspace"}
        </span>
        {session && (
          <button
            className="quiet"
            disabled={busy}
            onClick={async () => {
              await request("/api/logout", {});
              setSession(null);
              setRows([]);
              setDelivery(null);
              setBundle("");
            }}
          >
            Sign out
          </button>
        )}
      </header>
      <main>
        {config.development && (
          <p className="dev">
            Local demonstration · Synthetic sign-in, embedded database and test
            storage. No email is sent.
          </p>
        )}
        <div className="title">
          <div>
            <p className="eyebrow">PRIVATE BY DESIGN</p>
            <h1>
              {isRecipient ? (
                <>
                  Unlock your <em>delivery</em>
                </>
              ) : (
                <>
                  Send documents <em>securely</em>
                </>
              )}
            </h1>
            <p>
              {isRecipient
                ? "Use the bundle and password provided by your sender."
                : "Encrypt here. Share access on your terms."}
            </p>
            <div className="trust-points">
              <span>
                <Icon name="lock" />
                {ready ? "Client-side encryption active" : "Browser encryption"}
              </span>
              <span>
                <Icon name="users" />
                You control access
              </span>
              <span>
                <Icon name="shield" />
                Simple and secure
              </span>
            </div>
          </div>
          <PrivacyArtwork />
          <span className="pill">
            <Icon name="clock" />
            7-day access window
          </span>
        </div>
        <div
          ref={notice}
          tabIndex={-1}
          className={error ? "notice error" : message ? "notice" : ""}
          role={error ? "alert" : "status"}
        >
          {(error || message) && (
            <>
              <span className="notice-symbol">
                <Icon name={error ? "info" : "check"} />
              </span>
              <span>{error || message}</span>
              <button
                className="icon-button"
                type="button"
                aria-label="Dismiss notification"
                onClick={clearNotice}
              >
                <Icon name="close" />
              </button>
            </>
          )}
        </div>
        {!supported ? (
          <section className="panel">
            <h2>This browser cannot complete secure file delivery.</h2>
            <p>
              Use current desktop Chrome or Edge with storage enabled, in a
              secure browser window. This workflow needs local ciphertext
              storage and direct saving to files. Firefox and Safari
              compatibility has not been established.
            </p>
          </section>
        ) : !loaded ? (
          <p role="status">Loading…</p>
        ) : !isRecipient && !session ? (
          <section className="panel signin">
            <h2>Your sender workspace</h2>
            <p>Sign in to create, manage and revoke your deliveries.</p>
            <a className="button" href="/auth/login">
              {config.development
                ? "Use synthetic local sender"
                : "Sign in with your organization"}
            </a>
          </section>
        ) : (
          <div className="workspace">
            <section className="panel">
              <div className="panel-title">
                <span className="panel-icon">
                  <Icon name={isRecipient ? "lock" : "document"} />
                </span>
                <div className="panel-heading">
                  <h2>{isRecipient ? "Access package" : "New delivery"}</h2>
                  <p>
                    {isRecipient
                      ? "Unlock and verify your complete delivery."
                      : "Select your documents and create a secure delivery."}
                  </p>
                </div>
                <span className="step">
                  {isRecipient ? "01 / VERIFY" : "01 / ENCRYPT"}
                </span>
              </div>
              {isRecipient ? (
                <form onSubmit={receive}>
                  <p className="muted">
                    {incoming.repo && incoming.capability
                      ? "The access link is ready."
                      : "This link is incomplete. Ask your sender for a new link."}
                  </p>
                  <label htmlFor="bundle">Portable key bundle</label>
                  <textarea
                    id="bundle"
                    value={bundle}
                    maxLength={197}
                    onChange={(e) => setBundle(e.target.value)}
                    placeholder="Paste the sdb1. bundle"
                    disabled={busy || entries.length > 0}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <label className="file-label" htmlFor="bundle-file">
                    Or import a bundle file
                  </label>
                  <input
                    id="bundle-file"
                    type="file"
                    accept=".sdb"
                    disabled={busy || entries.length > 0}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        if (file.size !== 197)
                          setError(
                            "The bundle file must be exactly 197 bytes.",
                          );
                        else setBundle(await file.text());
                      }
                    }}
                  />
                  <label htmlFor="password">Bundle password</label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    maxLength={4096}
                    disabled={busy || entries.length > 0}
                  />
                  <button
                    className="primary"
                    disabled={
                      !ready ||
                      busy ||
                      entries.length > 0 ||
                      !incoming.repo ||
                      !incoming.capability ||
                      !bundle ||
                      !password
                    }
                  >
                    Retrieve and verify
                  </button>
                </form>
              ) : (
                <form onSubmit={send}>
                  <label htmlFor="files">Documents</label>
                  <div className="file-zone">
                    <div className="file-control">
                      <input
                        id="files"
                        type="file"
                        multiple
                        disabled={busy}
                        onChange={(e) =>
                          setFiles(Array.from(e.target.files ?? []))
                        }
                      />
                      {files.length > 0 && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Clear selected documents"
                          disabled={busy}
                          onClick={() => {
                            setFiles([]);
                            const input = document.getElementById(
                              "files",
                            ) as HTMLInputElement;
                            input.value = "";
                          }}
                        >
                          <Icon name="close" />
                        </button>
                      )}
                    </div>
                    <p>Up to 100 files · 250 MiB each · 1 GiB total</p>
                  </div>
                  {files.length > 0 && (
                    <p className="muted">
                      {files.length} selected ·{" "}
                      {formatBytes(files.reduce((n, f) => n + f.size, 0))}
                    </p>
                  )}
                  <label htmlFor="password">Bundle password</label>
                  <div className="input-group password-group">
                    <span className="input-icon">
                      <Icon name="key" />
                    </span>
                    <input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="new-password"
                      maxLength={4096}
                      disabled={busy}
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={
                        showPassword ? "Hide password" : "Show password"
                      }
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      <Icon name={showPassword ? "eyeOff" : "eye"} />
                    </button>
                  </div>
                  <p className="hint">
                    A random password is provided. Custom passwords need at
                    least 15 characters. Save this separately; there is no
                    recovery.
                  </p>
                  <button
                    className="primary"
                    disabled={!ready || busy || files.length < 1}
                  >
                    <Icon name="lock" />
                    Encrypt and create delivery
                    <Icon name="arrow" className="button-arrow" />
                  </button>
                </form>
              )}
              {busy && (
                <div className="progress">
                  <p aria-live="polite">{phase || "Preparing…"}</p>
                  <progress
                    value={progress}
                    max={100}
                    aria-label={phase || "Preparing"}
                  />
                  <button type="button" className="quiet" onClick={cancel}>
                    Cancel operation
                  </button>
                </div>
              )}
            </section>
            <section className="panel">
              <div className="panel-title">
                <span className="panel-icon">
                  <Icon name={isRecipient ? "shield" : "share"} />
                </span>
                <div className="panel-heading">
                  <h2>{isRecipient ? "Verified files" : "Share delivery"}</h2>
                  <p>
                    {isRecipient
                      ? "Save your files after full verification."
                      : "Copy the link and share it with your recipient."}
                  </p>
                </div>
                <span className="step">02 / SAVE & SHARE</span>
              </div>
              {isRecipient ? (
                <>
                  {entries.length === 0 ? (
                    <div className="empty">
                      <span className="empty-art" aria-hidden="true">
                        <Icon name={isRecipient ? "shield" : "share"} />
                      </span>
                      <h3>Verification comes first</h3>
                      <p>
                        Individual downloads and ZIP output become available
                        only after the complete package passes verification.
                      </p>
                      <button disabled>Download all as ZIP</button>
                    </div>
                  ) : (
                    <>
                      <p className="verified">Entire package verified</p>
                      <ul className="files">
                        {entries.map((e, i) => (
                          <li key={i}>
                            <div>
                              <strong>{e.name}</strong>
                              <span>{formatBytes(e.size)}</span>
                            </div>
                            <button
                              disabled={busy}
                              onClick={() => void save(i)}
                            >
                              Save file
                            </button>
                          </li>
                        ))}
                      </ul>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() => void save(-1)}
                      >
                        Download all as ZIP
                      </button>
                      <button
                        className="quiet"
                        disabled={busy}
                        onClick={() =>
                          worker.current?.postMessage({ type: "clear" })
                        }
                      >
                        Remove local ciphertext
                      </button>
                    </>
                  )}
                </>
              ) : delivery?.expiresAt ? (
                <>
                  <p className="expiry">
                    <Icon name="clock" />
                    Available until{" "}
                    <strong>
                      {new Date(delivery.expiresAt).toLocaleString()}
                    </strong>
                  </p>
                  <label htmlFor="link">Recipient link</label>
                  <input
                    id="link"
                    readOnly
                    value={`${location.origin}/receive#r=${delivery.id}&c=${delivery.capability}`}
                  />
                  <div className="share-actions">
                    <button
                      className="accent"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(
                            `${location.origin}/receive#r=${delivery.id}&c=${delivery.capability}`,
                          )
                          .then(() => setMessage("Link copied."))
                          .catch(() =>
                            setError("Select and copy the link manually."),
                          );
                      }}
                    >
                      <Icon name="copy" />
                      Copy link
                    </button>
                    {bundle && (
                      <button onClick={downloadBundle}>
                        <Icon name="download" />
                        Save key bundle
                      </button>
                    )}
                  </div>
                  <p className="hint">
                    Send the bundle and password through separate channels. The
                    service cannot recover them. This link is shown only in this
                    session; reissuing it invalidates earlier links.
                  </p>
                  {config.emailEnabled ? (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        clearNotice();
                        setMailBusy(true);
                        try {
                          await request(
                            `/api/repositories/${delivery.id}/email`,
                            {
                              addresses: addresses
                                .split(/[;,\n]/)
                                .map((x) => x.trim())
                                .filter(Boolean),
                              capability: delivery.capability,
                            },
                          );
                          setAddresses("");
                          setMessage(
                            "Email accepted by the provider. This does not confirm delivery.",
                          );
                        } catch {
                          setError(
                            "Email was not accepted. Your delivery is intact; retry explicitly when ready.",
                          );
                        } finally {
                          setMailBusy(false);
                        }
                      }}
                    >
                      <label htmlFor="addresses">
                        Email the link (optional)
                      </label>
                      <textarea
                        id="addresses"
                        value={addresses}
                        onChange={(e) => setAddresses(e.target.value)}
                        maxLength={5100}
                        placeholder="Addresses separated by commas"
                        autoComplete="off"
                      />
                      <p className="hint">
                        Only a generic link and expiry are sent. Addresses are
                        not saved in this application.
                      </p>
                      <button disabled={mailBusy || !addresses}>
                        {mailBusy ? "Submitting…" : "Send link email"}
                      </button>
                    </form>
                  ) : (
                    <p className="hint email-info">
                      <Icon name="info" />
                      <span>
                        Link email is disabled for this deployment. Copy the
                        link and share it through your approved channel.
                      </span>
                    </p>
                  )}
                </>
              ) : (
                <div className="empty">
                  <span className="empty-art" aria-hidden="true">
                    <Icon name={isRecipient ? "shield" : "share"} />
                  </span>
                  <h3>Ready when you are</h3>
                  <p>
                    Your link and portable bundle appear here after encryption
                    and upload finish.
                  </p>
                </div>
              )}
            </section>
          </div>
        )}
        {session && !isRecipient && (
          <section className="panel deliveries">
            <div className="panel-title">
              <h2>Your deliveries</h2>
              <button className="quiet" onClick={() => void refresh()}>
                Refresh
              </button>
            </div>
            {more && (
              <button
                onClick={async () => {
                  try {
                    const batch = await request(
                      `/api/repositories?cursor=${rows.at(-1)!.id}`,
                    );
                    setRows((previous) => [...previous, ...batch]);
                    setMore(batch.length === 100);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Load older deliveries
              </button>
            )}
            {rows.length ? (
              <ul className="rows">
                {rows.map((row) => (
                  <li key={row.id}>
                    <div>
                      <code>{row.id}</code>
                      <span>
                        Created {new Date(row.created_at).toLocaleString()}
                        {row.expires_at &&
                          ` · Expires ${new Date(row.expires_at).toLocaleString()}`}
                      </span>
                    </div>
                    <span className="state">{row.status}</span>
                    {row.status === "finalized" && (
                      <button onClick={() => void action(row, "reissue")}>
                        Reissue link
                      </button>
                    )}
                    {["pending", "uploading", "uploaded", "finalized"].includes(
                      row.status,
                    ) && (
                      <button
                        className="danger"
                        onClick={() => void action(row, "revoke")}
                      >
                        Revoke
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                No deliveries yet. File names and counts never appear in this
                server listing.
              </p>
            )}
          </section>
        )}
        <footer>
          <p className="footer-brand">
            {config.brandName}
            <span>Private by design.</span>
          </p>
          <div className="footer-links">
            <details>
              <summary>Help</summary>
              <div className="footer-popover">
                <strong>Need a hand?</strong>
                <p>{config.supportText}</p>
                <p>
                  Keep your bundle and password safe. There is no recovery.
                  Share the link, bundle, and password through separate
                  channels.
                </p>
              </div>
            </details>
            <span aria-hidden="true">·</span>
            <details>
              <summary>Privacy</summary>
              <div className="footer-popover">
                <strong>Your files stay under your control.</strong>
                <p>
                  Keys and document encryption stay in this browser. Only
                  ciphertext reaches the service. Access expires after seven
                  days and can be revoked sooner. Downloaded copies cannot be
                  recalled.
                </p>
                <p>No document previews. No administrator decryption.</p>
              </div>
            </details>
          </div>
        </footer>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
