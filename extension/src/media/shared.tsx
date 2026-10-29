import type { ReactNode } from "react";
import { downloadOriginal } from "./load";

export function Unsupported({ src, title, detail }: { src: string; title: string; detail?: string }) {
  return (
    <div className="mv-empty" role="alert">
      <div className="mv-empty-title">{title}</div>
      {detail && <div className="mv-empty-detail">{detail}</div>}
      <button className="mv-btn primary" onClick={() => void downloadOriginal(src)}>Download instead</button>
    </div>
  );
}

export function InfoPanel({ rows, children }: { rows: [string, ReactNode][]; children?: ReactNode }) {
  return (
    <aside className="mv-info" aria-label="File info">
      <dl>
        {rows.map(([k, v]) => (
          <div className="mv-row" key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {children}
    </aside>
  );
}

export function isTypingTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName));
}

export interface ViewerProps {
  src: string;
  name: string;
  mime: string | null;
  size: number | null;
  infoOpen: boolean;
  toast: (msg: string) => void;
}
