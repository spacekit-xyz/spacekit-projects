import React, { useEffect, useState, type FC } from "react";
import { fetchChatAttachmentBytes, parseStorageFileRef } from "../utils/chatAttachmentFetch";

function useAttachmentBlobUrl(
  url: string,
  storageBase: string | undefined,
  myDid: string | undefined,
  messagingApiBase?: string,
): { blobUrl: string | null; failed: boolean; loading: boolean } {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!parseStorageFileRef(url)) {
      setFailed(true);
      setLoading(false);
      return;
    }
    if (!storageBase && !messagingApiBase) {
      setFailed(true);
      setLoading(false);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setBlobUrl(null);
    (async () => {
      try {
        const { bytes, mimeType } = await fetchChatAttachmentBytes(
          url,
          storageBase ?? "",
          myDid,
          messagingApiBase,
        );
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        setBlobUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, storageBase, myDid, messagingApiBase]);

  return { blobUrl, failed, loading };
}

export const ChatAttachmentImage: FC<{
  url: string;
  name: string;
  storageBase?: string;
  messagingApiBase?: string;
  myDid?: string;
  onClick?: () => void;
}> = ({ url, name, storageBase, messagingApiBase, myDid, onClick }) => {
  const { blobUrl, failed, loading } = useAttachmentBlobUrl(url, storageBase, myDid, messagingApiBase);

  if (failed) {
    return (
      <div
        style={{
          padding: "8px 10px",
          borderRadius: 8,
          background: "rgba(239,68,68,0.08)",
          border: "1px solid rgba(239,68,68,0.25)",
          color: "#f87171",
          fontSize: 12,
        }}
      >
        Could not load {name}. Re-upload the file or refresh after services restart.
      </div>
    );
  }
  if (loading || !blobUrl) {
    return <div style={{ fontSize: 11, color: "#6b7280" }}>Loading {name}…</div>;
  }
  return (
    <div style={{ cursor: onClick ? "pointer" : undefined }} onClick={onClick}>
      <img src={blobUrl} alt={name} style={{ maxWidth: "100%", borderRadius: 8, display: "block" }} />
      <span style={{ fontSize: 10, color: "#6b7280", marginTop: 4, display: "block" }}>{name}</span>
    </div>
  );
};

export const ChatAttachmentVideo: FC<{
  url: string;
  name: string;
  storageBase?: string;
  messagingApiBase?: string;
  myDid?: string;
  onExpand?: () => void;
}> = ({ url, name, storageBase, messagingApiBase, myDid, onExpand }) => {
  const { blobUrl, failed, loading } = useAttachmentBlobUrl(url, storageBase, myDid, messagingApiBase);

  if (failed) {
    return (
      <div style={{ fontSize: 12, color: "#f87171" }}>
        Could not load video {name}
      </div>
    );
  }
  if (loading || !blobUrl) {
    return <div style={{ fontSize: 11, color: "#6b7280" }}>Loading {name}…</div>;
  }
  return (
    <div>
      <video
        src={blobUrl}
        controls
        style={{ maxWidth: "100%", borderRadius: 8, display: "block", cursor: onExpand ? "pointer" : undefined }}
        onDoubleClick={onExpand}
      />
      <span
        style={{
          fontSize: 10,
          color: "#6b7280",
          marginTop: 4,
          display: "block",
          cursor: onExpand ? "pointer" : undefined,
        }}
        onClick={onExpand}
      >
        {name} — tap to expand
      </span>
    </div>
  );
};

/** Lightbox / PDF / markdown fetch helper. */
export function useChatAttachmentBlobUrl(
  url: string,
  storageBase: string | undefined,
  myDid: string | undefined,
  enabled: boolean,
  messagingApiBase?: string,
): { blobUrl: string | null; failed: boolean; loading: boolean } {
  const state = useAttachmentBlobUrl(
    enabled ? url : "",
    enabled ? storageBase : undefined,
    myDid,
    enabled ? messagingApiBase : undefined,
  );
  if (!enabled) return { blobUrl: null, failed: false, loading: false };
  return state;
}
