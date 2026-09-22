import { useCallback, useEffect, useState, type FC } from "react";
import { SpacekitClient, type KyberKeyPair } from "@spacekit/sdk/client";
import { generateKyberKeypair, isKyberInitialized } from "@spacekit/sdk/kyber";
import { ensureEmbeddedKyber } from "../utils/embeddedKyber";

const KYBER_LS_KEY = "spacekit:kyber:keys:global";
const DEFAULT_KYBER = "kyber1024" as const;

const SK = {
  font: '"Hanken Grotesk", system-ui, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
} as const;

function isEmbedded(): boolean {
  return typeof window !== "undefined" && Boolean(window.spacekit?.storage?.putRecord);
}

interface HermesPqKeysPanelProps {
  accent?: string;
  onKeysChanged?: () => void;
}

const HermesPqKeysPanel: FC<HermesPqKeysPanelProps> = ({
  accent = "#7fd7e6",
  onKeysChanged,
}) => {
  const [keyState, setKeyState] = useState<KyberKeyPair | null>(null);
  const [kyberReady, setKyberReady] = useState(isKyberInitialized());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const refreshKeyState = useCallback(() => {
    setKeyState(SpacekitClient.getKyberKeys());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!isKyberInitialized()) await ensureEmbeddedKyber();
        if (!cancelled) setKyberReady(true);
      } catch {
        if (!cancelled) setStatus("Kyber WASM failed to load.");
      }
      refreshKeyState();
    })();
    return () => { cancelled = true; };
  }, [refreshKeyState]);

  const handleGenerate = async () => {
    if (!kyberReady) return;
    setBusy(true);
    setStatus(null);
    try {
      const keypair = await generateKyberKeypair(DEFAULT_KYBER);
      const rec: KyberKeyPair = {
        publicKey: keypair.publicKey,
        secretKey: keypair.secretKey,
        algorithm: keypair.algorithm,
        keyId: `kyber-${Date.now()}`,
        createdAt: Date.now(),
      };
      SpacekitClient.setKyberKeys(rec);
      refreshKeyState();
      onKeysChanged?.();
      setStatus("New keypair generated.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Key generation failed");
    } finally {
      setBusy(false);
    }
  };

  const handleDestroy = () => {
    localStorage.removeItem(KYBER_LS_KEY);
    refreshKeyState();
    onKeysChanged?.();
    setStatus("Keys removed from this browser.");
  };

  const handleRotate = async () => {
    localStorage.removeItem(KYBER_LS_KEY);
    await handleGenerate();
    setStatus("Keys rotated — new keypair active.");
  };

  const statusColor =
    status && (status.includes("failed") || status.includes("Failed"))
      ? "#fca5a5"
      : "#86efac";

  return (
    <div
      style={{
        marginBottom: 8,
        padding: "12px",
        borderRadius: 10,
        border: "1px solid rgba(103,232,249,0.15)",
        background: "rgba(103,232,249,0.04)",
      }}
    >
      {keyState ? (
        <div style={{ fontSize: 10, lineHeight: 1.6, marginBottom: 10, fontFamily: SK.mono, color: "#9ca3af" }}>
          <div><span style={{ color: "#6b7280" }}>Key </span>{keyState.keyId}</div>
          <div><span style={{ color: "#6b7280" }}>Alg </span>{keyState.algorithm}</div>
          <div style={{ wordBreak: "break-all" }}>
            <span style={{ color: "#6b7280" }}>PK </span>
            {keyState.publicKey.slice(0, 20)}…
          </div>
        </div>
      ) : (
        <p style={{ margin: "0 0 10px", fontSize: 11, color: "#fbbf24", fontFamily: SK.font }}>
          No PQ keypair in this browser.
        </p>
      )}

      {status && (
        <p style={{ margin: "0 0 10px", fontSize: 10, color: statusColor, fontFamily: SK.font }}>
          {status}
        </p>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button
          type="button"
          disabled={!kyberReady || busy}
          onClick={() => void handleGenerate()}
          style={{
            all: "unset",
            padding: "6px 10px",
            borderRadius: 6,
            fontSize: 10,
            fontWeight: 600,
            cursor: kyberReady && !busy ? "pointer" : "not-allowed",
            opacity: kyberReady && !busy ? 1 : 0.5,
            background: "rgba(103,232,249,0.1)",
            border: `1px solid rgba(103,232,249,0.25)`,
            color: accent,
            fontFamily: SK.font,
          }}
        >
          {busy ? "…" : keyState ? "New keypair" : "Generate"}
        </button>
        {keyState && (
          <>
            <button
              type="button"
              disabled={!kyberReady || busy}
              onClick={() => void handleRotate()}
              style={{
                all: "unset",
                padding: "6px 10px",
                borderRadius: 6,
                fontSize: 10,
                fontWeight: 600,
                cursor: kyberReady && !busy ? "pointer" : "not-allowed",
                opacity: kyberReady && !busy ? 1 : 0.5,
                border: "1px solid rgba(251,191,36,0.3)",
                background: "rgba(251,191,36,0.06)",
                color: "#fbbf24",
                fontFamily: SK.font,
              }}
            >
              Rotate
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleDestroy}
              style={{
                all: "unset",
                padding: "6px 10px",
                borderRadius: 6,
                fontSize: 10,
                fontWeight: 600,
                cursor: busy ? "not-allowed" : "pointer",
                opacity: busy ? 0.5 : 1,
                border: "1px solid rgba(244,63,94,0.3)",
                background: "rgba(244,63,94,0.06)",
                color: "#f43f5e",
                fontFamily: SK.font,
              }}
            >
              Destroy
            </button>
          </>
        )}
      </div>

      {!isEmbedded() && (
        <a
          href="/keymaster"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-block",
            marginTop: 10,
            fontSize: 10,
            fontWeight: 600,
            color: accent,
            fontFamily: SK.font,
            textDecoration: "none",
          }}
        >
          Full Keymaster (backup & SLA) ↗
        </a>
      )}
    </div>
  );
};

export default HermesPqKeysPanel;
