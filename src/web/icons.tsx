import React from "react";
type IconName =
  | "lock"
  | "document"
  | "share"
  | "clock"
  | "copy"
  | "download"
  | "upload"
  | "key"
  | "eye"
  | "eyeOff"
  | "close"
  | "check"
  | "users"
  | "shield"
  | "arrow"
  | "info";
const paths: Record<IconName, React.ReactNode> = {
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3" />
    </>
  ),
  document: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m9 10 6-4M9 14l6 4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="6" width="12" height="15" rx="2" />
      <path d="M15 6V3H4v14h4" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" />
    </>
  ),
  key: (
    <>
      <path d="m14 10-9 10H2v-3L12 7" />
      <circle cx="16" cy="7" r="5" />
      <path d="m4 15 3 3" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="m3 3 18 18M10 5a12 12 0 0 1 12 7 18 18 0 0 1-4 4M6 6a20 20 0 0 0-4 6s4 7 10 7a13 13 0 0 0 5-1M10 10a3 3 0 0 0 4 4" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  users: (
    <>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 21v-3a6 6 0 0 1 12 0v3M17 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v3" />
    </>
  ),
  shield: <path d="m12 2 8 3v6c0 5-5 9-8 11-3-2-8-6-8-11V5z" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7v.1" />
    </>
  ),
};
export function Icon({
  name,
  className = "",
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      className={`icon ${className}`}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export function PrivacyArtwork() {
  return (
    <div className="privacy-art" aria-hidden="true">
      <div className="paper paper-back">
        <i />
        <i />
        <i />
      </div>
      <div className="paper paper-front">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="art-lock">
        <Icon name="lock" />
      </div>
      <div className="art-note">
        Your files.
        <br />
        <span>Your control.</span>
        <svg viewBox="0 0 80 30">
          <path d="M75 3C64 28 30 25 7 16m0 0 12 1M7 16l7 9" />
        </svg>
      </div>
    </div>
  );
}
