import type { CSSProperties, ReactNode } from "react";

// ------------------------------------------------------------
// SpaceKit ecosystem tokens (matches @spacekit/adkit styling)
// ------------------------------------------------------------
export const T = {
  bg: "#0B1120",
  panel: "#111A2E",
  panelRaised: "#16213A",
  line: "#1E2A44",
  ink: "#E6EDF7",
  dim: "#8CA0BF",
  faint: "#5B6B8C",
  teal: "#5EEAD4",
  tealDeep: "#0E2E2B",
  amber: "#F5B95E",
  red: "#F87171",
  violet: "#A78BFA",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  sans: "'Sora', 'Inter', system-ui, -apple-system, sans-serif",
} as const;

export const styles = {
  label: {
    fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase",
    color: T.faint, fontWeight: 600,
  } as CSSProperties,
  input: {
    background: T.bg, border: `1px solid ${T.line}`, borderRadius: 8,
    color: T.ink, padding: "8px 10px", fontSize: 13, fontFamily: T.sans,
    outline: "none", width: "100%", boxSizing: "border-box" as const,
  } as CSSProperties,
  card: {
    background: T.panel, border: `1px solid ${T.line}`, borderRadius: 12, padding: 14,
  } as CSSProperties,
};

export function Btn(props: {
  children: ReactNode; onClick?: () => void; kind?: "primary" | "ghost" | "danger";
  disabled?: boolean; small?: boolean; title?: string; type?: "button" | "submit";
}) {
  const { kind = "ghost", small } = props;
  const base: CSSProperties = {
    borderRadius: 8, cursor: props.disabled ? "default" : "pointer",
    fontSize: small ? 12 : 13, fontWeight: 600, fontFamily: T.sans,
    padding: small ? "5px 10px" : "8px 14px",
    border: `1px solid ${kind === "primary" ? T.teal : T.line}`,
    background: kind === "primary" ? T.teal : "transparent",
    color: kind === "primary" ? "#04201B" : kind === "danger" ? T.red : T.ink,
    opacity: props.disabled ? 0.45 : 1,
    transition: "filter 120ms ease",
  };
  return (
    <button
      type={props.type ?? "button"}
      style={base}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.filter = "brightness(1.15)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.filter = "none"; }}
    >
      {props.children}
    </button>
  );
}

export function Tag({ children, color }: { children: ReactNode; color?: string }) {
  const c = color ?? T.dim;
  return (
    <span style={{
      fontSize: 11, color: c, border: `1px solid ${c}44`, background: `${c}14`,
      borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}

/**
 * AnchorSeal — the CRM's trust mark. A note that has been anchored
 * on-chain wears this stamp: tx fragment + timestamp, teal when the
 * proof checks out, red if the local content no longer matches it.
 */
export function AnchorSeal(props: { tx: string; timestamp: number; state: "anchored" | "verified" | "tampered" }) {
  const color = props.state === "tampered" ? T.red : T.teal;
  const word = props.state === "tampered" ? "Tampered" : props.state === "verified" ? "Verified" : "Anchored";
  return (
    <span
      title={`tx ${props.tx}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        border: `1px dashed ${color}`, color, borderRadius: 6,
        padding: "2px 8px", fontSize: 10, fontFamily: T.mono,
        background: props.state === "tampered" ? `${T.red}14` : T.tealDeep,
        letterSpacing: "0.06em",
      }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <circle cx="5" cy="5" r="4" fill="none" stroke={color} strokeWidth="1.2" />
        <path d="M5 1 v8 M2 6.5 c1.5 1.5 4.5 1.5 6 0" fill="none" stroke={color} strokeWidth="1.2" />
      </svg>
      {word} · {props.tx.slice(0, 8)}… · {new Date(props.timestamp).toLocaleDateString()}
    </span>
  );
}

export function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div style={{ padding: "40px 16px", textAlign: "center" }}>
      <div style={{ color: T.dim, fontSize: 14, fontWeight: 600 }}>{title}</div>
      <div style={{ color: T.faint, fontSize: 12, marginTop: 6 }}>{hint}</div>
    </div>
  );
}

export function fmtUsd(v: number): string {
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
