import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type KeyboardEvent,
} from "react";
import {
  getMessagingEnvelopeUrl,
  getMessagingHttpBase,
  getMessagingStreamUrl,
  getMessagingWebsiteApiBase,
  getMessagingDeleteUrl,
  getSocialDirectoryApiBase,
  getChatAttachmentStorageBase,
} from "./config/spacekitEndpoints";
import {
  saveConversationArchive,
  loadConversationArchive,
} from "./utils/messagingArchive";
import {
  getAllThreads,
  putAllThreads,
  mergeThreads,
  deleteThread,
} from "./utils/messagingIdb";
import "./hermes.css";
import { SpacekitClient } from "@spacekit/sdk/client";
import {
  initKyber,
  encryptWithKyber,
  decryptWithKyber,
  serializeEncryptedData,
  deserializeEncryptedData,
  isKyberInitialized,
} from "@spacekit/sdk/kyber";
import { ensureEmbeddedKyber } from "./utils/embeddedKyber";
import HermesPqKeysPanel from "./components/HermesPqKeysPanel";
import { uploadChatAttachment } from "./utils/storageUpload";
import { parseStorageFileRef } from "./utils/chatAttachmentFetch";
import {
  ChatAttachmentImage,
  ChatAttachmentVideo,
  useChatAttachmentBlobUrl,
} from "./components/ChatAttachmentMedia";
import { useAccount, useSignMessage } from "wagmi";
import {
  loadIdentitySnapshot,
  persistIdentitySnapshot,
  subscribeIdentityChanges,
} from "./utils/identitySync";
import { formatUserFacingError } from "./utils/userFacingError";
import { loadWebsiteAuthHeaders } from "./utils/websiteAuth";

const LS_DID = "spacekit.messaging.myDid";
const LS_NAME = "spacekit.messaging.displayName";
const LS_BLOCKED = "spacekit.messaging.blocked";
const LS_ORGS = "spacekit.messaging.orgs";
const LS_ACTIVE_ORG = "spacekit.messaging.activeOrg";

/** Matches SpaceKit AuthenticatedHome appshell palette. */
const SK = {
  bg: "#0c1020",
  ink: "#eef0f7",
  ink2: "#a6acc2",
  plasma: "#7fd7e6",
  gold: "#f3c879",
  font: '"Hanken Grotesk", system-ui, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
} as const;

function isSpacekitEmbedded(): boolean {
  return typeof window !== "undefined" && Boolean(window.spacekit?.storage?.putRecord);
}

type Org = {
  id: string;
  name: string;
  iconUrl?: string;
  ownerDid: string;
  memberDids: string[];
  groupId?: string;
  createdAt: string;
};

function groupThreadKey(memberDids: string[]): string {
  return `group:${[...memberDids].sort().join(",")}`;
}

/** Stable channel thread — history persists when members are added (Slack-like). */
function channelThreadKey(groupId: string): string {
  return `channel:${groupId}`;
}

function channelMetaForThread(
  peer: string,
  channels: Array<{ id: string; name: string; member_dids: string[] }>,
): { id: string; name: string; member_dids: string[] } | null {
  if (!peer.startsWith("channel:")) return null;
  const groupId = peer.slice(8);
  return channels.find((g) => g.id === groupId) ?? null;
}

/** True for real group/org channels — not a 1:1 DM (which also has 2 participants). */
function isGroupPayload(payload: {
  conversation_type?: string;
  group_id?: string | null;
  participants?: string[];
}): boolean {
  if (payload.conversation_type === "group") return true;
  if (payload.group_id) return true;
  return (payload.participants?.length ?? 0) > 2;
}

function inboundThreadKey(
  sender: string,
  payload: { conversation_type?: string; group_id?: string | null; participants?: string[] },
): string {
  if (payload.group_id) {
    return channelThreadKey(String(payload.group_id));
  }
  const participants = Array.isArray(payload.participants) ? payload.participants : [];
  if (isGroupPayload({ ...payload, participants })) {
    return groupThreadKey(participants);
  }
  return sender;
}

/** Legacy mis-filed DMs stored under `group:alice,astor` (2 members, no registered group id). */
function isDmGroupThreadKey(peer: string, myDid: string): boolean {
  if (!peer.startsWith("group:")) return false;
  const members = peer.slice(6).split(",").filter(Boolean);
  return members.length === 2 && members.includes(myDid);
}

function dmPeerFromThread(peer: string, myDid: string): string | null {
  if (!isDmGroupThreadKey(peer, myDid)) return null;
  return peer.slice(6).split(",").find((d) => d !== myDid) ?? null;
}

/** Don't treat registered channels as legacy 2-member DMs. */
function dmPeerFromThreadUnlessRegistered(
  peer: string,
  myDid: string,
  registeredGroupThreads: ReadonlySet<string>,
): string | null {
  if (peer.startsWith("channel:")) return null;
  if (peer.startsWith("group:") && registeredGroupThreads.has(peer)) return null;
  return dmPeerFromThread(peer, myDid);
}

function formatMessageTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function mergeThreadMessages(
  primary: ThreadMsg[] | undefined,
  secondary: ThreadMsg[] | undefined,
): ThreadMsg[] {
  const seen = new Set<string>();
  const merged: ThreadMsg[] = [];
  for (const msg of [...(primary ?? []), ...(secondary ?? [])]) {
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    merged.push(msg);
  }
  return merged.slice(-200);
}

function storageKeyForDid(base: string, did: string): string {
  return `${base}:${did}`;
}

function readActiveOrgId(did: string): string | null {
  try {
    return localStorage.getItem(storageKeyForDid(LS_ACTIVE_ORG, did));
  } catch {
    return null;
  }
}

function normalizeDid(did: string): string {
  return did.trim().toLowerCase();
}

function inboxSinceStorageKey(did: string): string {
  return `spacekit.messaging.inboxSince:${normalizeDid(did)}`;
}

function tombstonesSinceStorageKey(did: string): string {
  return `spacekit.messaging.tombstonesSince:${normalizeDid(did)}`;
}

/** Accept `alice`, `@alice`, or `did:spacekit:user:alice` → canonical DID. */
async function resolvePeerInput(
  raw: string,
  apiBase: string | undefined,
): Promise<{ did: string; unregistered?: boolean } | { error: string }> {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "Enter a username or DID." };

  if (trimmed.startsWith("did:")) {
    return { did: normalizeDid(trimmed) };
  }

  const username = trimmed.replace(/^@/, "").toLowerCase();
  if (username.length < 3) {
    return { error: "Username must be at least 3 characters." };
  }

  if (apiBase) {
    try {
      const res = await fetch(`${apiBase}/api/did/resolve/${encodeURIComponent(username)}`);
      if (res.ok) {
        const data = await res.json() as { found?: boolean; registration?: { did?: string } };
        if (data.found && data.registration?.did) {
          return { did: normalizeDid(data.registration.did) };
        }
      }
    } catch { /* fall through to constructed DID */ }
  }

  return { did: `did:spacekit:user:${username}`, unregistered: true };
}

const MESSAGING_SIDEBAR_PX = 286;
const MESSAGING_MOBILE_MAX_WIDTH = 768;
/** Fixed sidebar/backdrop start below global topbar + in-page ☰ bar so taps aren’t stolen by the shell header. */
const MESSAGING_MOBILE_OVERLAY_TOP =
  "calc(env(safe-area-inset-top, 0px) + 108px)";

const chatPlainBodyStyle: CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const URL_RE = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

function linkLabel(href: string): string {
  try {
    const u = new URL(href);
    let label = u.hostname.replace(/^www\./, "");
    if (u.pathname && u.pathname !== "/") {
      const seg = u.pathname.split("/").filter(Boolean);
      if (seg.length) label += `/${seg.length > 2 ? "…/" + seg[seg.length - 1] : seg.join("/")}`;
    }
    return label;
  } catch {
    return href.length > 48 ? href.slice(0, 45) + "…" : href;
  }
}

const linkChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 8px",
  margin: "1px 2px",
  borderRadius: 6,
  background: "rgba(34,211,238,0.12)",
  border: "1px solid rgba(34,211,238,0.28)",
  color: "#7fd7e6",
  fontSize: 12,
  fontFamily: SK.font,
  textDecoration: "none",
  cursor: "pointer",
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  lineHeight: 1.6,
  verticalAlign: "middle",
};

const RichText: FC<{ text: string }> = ({ text }) => {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(URL_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(<span key={`p${last}`}>{text.slice(last, m.index)}</span>);
    }
    const href = m[0].replace(/[.,;:!?)]+$/, "");
    const trailing = m[0].slice(href.length);
    nodes.push(
      <a
        key={`l${m.index}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={linkChipStyle}
        title={href}
      >
        🔗 {linkLabel(href)}
      </a>,
    );
    if (trailing) nodes.push(<span key={`s${m.index}`}>{trailing}</span>);
    last = m.index + m[0].length;
  }
  if (nodes.length === 0) return <>{text}</>;
  if (last < text.length) nodes.push(<span key={`p${last}`}>{text.slice(last)}</span>);
  return <>{nodes}</>;
};

type ThreadMsg = {
  id: string;
  role: "user" | "peer";
  content: string;
  createdAt: string;
  senderDid?: string;
};

type ThreadsState = Record<string, ThreadMsg[]>;

function migrateChannelThread(
  prev: ThreadsState,
  groupId: string,
  memberDids: string[],
): ThreadsState {
  const target = channelThreadKey(groupId);
  const legacy = groupThreadKey(memberDids);
  if (legacy === target) return prev;
  const merged = mergeThreadMessages(prev[target], prev[legacy]);
  if (merged.length === 0 && !prev[legacy]) return prev;
  const next = { ...prev, [target]: merged };
  if (legacy !== target && prev[legacy]) delete next[legacy];
  return next;
}

type SocialEntry = {
  did: string;
  display_name: string;
  /** Omitted in older stored rows — treat as visible in directory. */
  public?: boolean;
  registered_at: string;
};

/** Section labels on dark sidebar (avoid #2d3748 — invisible on mobile OLED). */
const SIDEBAR_SECTION_LABEL = "#94a3b8";

function safeUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const h = [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function useMessagingNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia(`(max-width: ${MESSAGING_MOBILE_MAX_WIDTH}px)`).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(max-width: ${MESSAGING_MOBILE_MAX_WIDTH}px)`);
    const onChange = (): void => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

function loadBlocked(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_BLOCKED);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveBlocked(s: Set<string>) {
  localStorage.setItem(LS_BLOCKED, JSON.stringify([...s]));
}

function didMonogram(did: string): string {
  const tail = did.split(":").pop() ?? did;
  const t = tail.replace(/[^a-zA-Z0-9]/g, "");
  return (t.slice(0, 2) || "??").toUpperCase();
}

function displayNameForDid(did: string, directory: SocialEntry[]): string {
  const hit = directory.find((e) => e.did === did);
  if (hit?.display_name) return hit.display_name;
  if (did.length > 28) return `${did.slice(0, 14)}…${did.slice(-8)}`;
  return did;
}

const PeerAvatar: FC<{ did: string }> = ({ did }) => (
  <div
    style={{
      width: 26,
      height: 26,
      borderRadius: 7,
      background: "rgba(103,232,249,0.12)",
      border: "1px solid rgba(103,232,249,0.25)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
      marginRight: 10,
      marginTop: 2,
      fontFamily: SK.mono,
      fontSize: 9,
      fontWeight: 600,
      color: "#7fd7e6",
    }}
  >
    {didMonogram(did)}
  </div>
);

const DmBubble: FC<{
  role: "user" | "peer";
  content: string;
  peerDid: string;
  senderDid?: string;
  senderLabel?: string;
  createdAt?: string;
  layout?: "dm" | "channel";
  narrow?: boolean;
  messageId?: string;
  storageBase?: string;
  messagingApiBase?: string;
  myDid?: string;
  onDeleteMessage?: (messageId: string) => void;
  onMediaClick?: (tag: LightboxTag, url: string, name: string) => void;
}> = ({
  role,
  content,
  peerDid,
  senderDid,
  senderLabel,
  createdAt,
  layout = "dm",
  narrow,
  messageId,
  storageBase,
  messagingApiBase,
  myDid,
  onDeleteMessage,
  onMediaClick,
}) => {
  const isUser = role === "user";
  const avatarDid = isUser ? peerDid : (senderDid ?? peerDid);
  const bubbleMax = narrow ? "min(92%, calc(100vw - 48px))" : "70%";

  const messageBody = (() => {
    const mediaRe = /\[(img|video|pdf|md|file):([^\]]*)\]\(([^)]+)\)/g;
    const parts: React.ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    const fileChipBase: CSSProperties = {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "6px 12px",
      margin: "4px 0",
      borderRadius: 8,
      fontSize: 12,
      fontFamily: SK.font,
      cursor: "pointer",
      maxWidth: "100%",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    };
    while ((m = mediaRe.exec(content)) !== null) {
      if (m.index > last) {
        parts.push(
          <span key={`t${last}`} style={chatPlainBodyStyle}>
            <RichText text={content.slice(last, m.index)} />
          </span>,
        );
      }
      const [, tag, name, url] = m;
      const expandClick = onMediaClick ? () => onMediaClick(tag as LightboxTag, url, name) : undefined;
      const isStorageRef = Boolean(parseStorageFileRef(url));
      if (tag === "img") {
        parts.push(
          <div key={`m${m.index}`}>
            {isStorageRef ? (
              <ChatAttachmentImage
                url={url}
                name={name}
                storageBase={storageBase}
                messagingApiBase={messagingApiBase}
                myDid={myDid}
                onClick={expandClick}
              />
            ) : (
              <div style={{ cursor: onMediaClick ? "pointer" : undefined }} onClick={expandClick}>
                <img src={url} alt={name} style={{ maxWidth: "100%", borderRadius: 8, display: "block" }} />
                <span style={{ fontSize: 10, color: "#6b7280", marginTop: 4, display: "block" }}>{name}</span>
              </div>
            )}
          </div>,
        );
      } else if (tag === "video") {
        parts.push(
          <div key={`m${m.index}`}>
            {isStorageRef ? (
              <ChatAttachmentVideo
                url={url}
                name={name}
                storageBase={storageBase}
                messagingApiBase={messagingApiBase}
                myDid={myDid}
                onExpand={expandClick}
              />
            ) : (
              <div>
                <video
                  src={url}
                  controls
                  style={{ maxWidth: "100%", borderRadius: 8, display: "block", cursor: onMediaClick ? "pointer" : undefined }}
                  onDoubleClick={expandClick}
                />
                <span
                  style={{ fontSize: 10, color: "#6b7280", marginTop: 4, display: "block", cursor: onMediaClick ? "pointer" : undefined }}
                  onClick={expandClick}
                >
                  {name} — tap to expand
                </span>
              </div>
            )}
          </div>,
        );
      } else if (tag === "pdf") {
        parts.push(
          <div
            key={`m${m.index}`}
            onClick={expandClick}
            style={{ ...fileChipBase, background: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.30)", color: "#f87171" }}
          >
            📄 {name}
          </div>,
        );
      } else if (tag === "md") {
        parts.push(
          <div
            key={`m${m.index}`}
            onClick={expandClick}
            style={{ ...fileChipBase, background: "rgba(16,185,129,0.10)", border: "1px solid rgba(16,185,129,0.30)", color: "#34d399" }}
          >
            📝 {name}
          </div>,
        );
      } else {
        parts.push(
          <div
            key={`m${m.index}`}
            onClick={expandClick}
            style={{ ...fileChipBase, background: "rgba(156,163,175,0.10)", border: "1px solid rgba(156,163,175,0.30)", color: "#9ca3af" }}
          >
            📎 {name}
          </div>,
        );
      }
      last = m.index + m[0].length;
    }
    if (parts.length === 0) {
      return (
        <span style={chatPlainBodyStyle}>
          <RichText text={content} />
        </span>
      );
    }
    if (last < content.length) {
      parts.push(
        <span key={`t${last}`} style={chatPlainBodyStyle}>
          <RichText text={content.slice(last)} />
        </span>,
      );
    }
    return <>{parts}</>;
  })();

  if (layout === "channel") {
    const deleteBtn =
      isUser && messageId && onDeleteMessage ? (
        <button
          type="button"
          className="slack-message-delete"
          title="Delete message"
          onClick={() => onDeleteMessage(messageId)}
        >
          Delete
        </button>
      ) : null;
    return (
      <div className="slack-message-row">
        <div className="slack-message-avatar">
          <PeerAvatar did={avatarDid} />
        </div>
        <div className="slack-message-body">
          <div className="slack-message-meta">
            <span className="slack-message-author">{senderLabel ?? avatarDid.split(":").pop()}</span>
            {createdAt ? (
              <span className="slack-message-time">{formatMessageTime(createdAt)}</span>
            ) : null}
            {deleteBtn}
          </div>
          <div className="slack-message-text">{messageBody}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`dm-message-row${isUser ? " dm-message-row--self" : ""}`}
      style={{ justifyContent: isUser ? "flex-end" : "flex-start" }}
    >
      {!isUser && <PeerAvatar did={avatarDid} />}
      <div style={{ maxWidth: bubbleMax, minWidth: 0 }}>
        {isUser && messageId && onDeleteMessage ? (
          <div className="dm-message-actions">
            <button
              type="button"
              className="dm-message-delete"
              title="Delete message"
              onClick={() => onDeleteMessage(messageId)}
            >
              Delete
            </button>
          </div>
        ) : null}
        <div className={isUser ? "dm-bubble dm-bubble--self" : "dm-bubble dm-bubble--peer"}>
          {messageBody}
        </div>
      </div>
    </div>
  );
};

type LightboxTag = "img" | "video" | "pdf" | "md" | "file";

function simpleMdToHtml(md: string): string {
  return md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code style='background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:4px;font-size:12px'>$1</code>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/gs, "<ul style='margin:4px 0;padding-left:20px'>$1</ul>")
    .replace(/\n{2,}/g, "<br/><br/>")
    .replace(/\n/g, "<br/>");
}

const MediaLightbox: FC<{
  tag: LightboxTag;
  url: string;
  name: string;
  storageBase?: string;
  messagingApiBase?: string;
  myDid?: string;
  onClose: () => void;
}> = ({ tag, url, name, storageBase, messagingApiBase, myDid, onClose }) => {
  const [mdContent, setMdContent] = useState<string | null>(null);
  const [mdLoading, setMdLoading] = useState(false);
  const storageRef = parseStorageFileRef(url);
  const { blobUrl: attachmentBlobUrl, failed: attachmentFailed, loading: attachmentLoading } =
    useChatAttachmentBlobUrl(url, storageBase, myDid, Boolean(storageRef), messagingApiBase);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);

  useEffect(() => {
    if (tag !== "md") return;
    if (storageRef) {
      if (attachmentLoading) {
        setMdLoading(true);
        return;
      }
      if (attachmentFailed || !attachmentBlobUrl) {
        setMdContent("*Failed to load markdown content.*");
        setMdLoading(false);
        return;
      }
      setMdLoading(true);
      fetch(attachmentBlobUrl)
        .then((r) => r.text())
        .then((t) => setMdContent(t))
        .catch(() => setMdContent("*Failed to load markdown content.*"))
        .finally(() => setMdLoading(false));
      return;
    }
    setMdLoading(true);
    fetch(url)
      .then((r) => r.text())
      .then((t) => setMdContent(t))
      .catch(() => setMdContent("*Failed to load markdown content.*"))
      .finally(() => setMdLoading(false));
  }, [tag, url, storageRef, attachmentBlobUrl, attachmentLoading, attachmentFailed]);

  useEffect(() => {
    if (tag !== "pdf") return;
    if (storageRef) {
      setPdfLoading(attachmentLoading);
      setPdfBlobUrl(attachmentBlobUrl);
      return;
    }
    setPdfLoading(true);
    let objectUrl: string | null = null;
    fetch(url)
      .then((r) => r.blob())
      .then((blob) => {
        const pdfBlob = new Blob([blob], { type: "application/pdf" });
        objectUrl = URL.createObjectURL(pdfBlob);
        setPdfBlobUrl(objectUrl);
      })
      .catch(() => setPdfBlobUrl(null))
      .finally(() => setPdfLoading(false));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [tag, url, storageRef, attachmentBlobUrl, attachmentLoading]);

  const overlayStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 9999,
    background: "rgba(0,0,0,0.88)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    cursor: "zoom-out",
  };

  const closeBtn = (
    <button
      type="button"
      onClick={onClose}
      style={{
        position: "absolute",
        top: 16,
        right: 20,
        all: "unset",
        cursor: "pointer",
        fontSize: 28,
        color: "#e5e7eb",
        fontWeight: 700,
        lineHeight: 1,
        zIndex: 10000,
      }}
    >
      ✕
    </button>
  );

  const nameLabel = <span style={{ color: "#9ca3af", fontSize: 12, marginTop: 10 }}>{name}</span>;

  if (tag === "img") {
    const imgSrc = storageRef ? attachmentBlobUrl : url;
    return (
      <div onClick={onClose} style={overlayStyle}>
        {closeBtn}
        {attachmentLoading && storageRef ? (
          <span style={{ color: "#9ca3af", fontSize: 14 }}>Loading image…</span>
        ) : attachmentFailed && storageRef ? (
          <span style={{ color: "#f87171", fontSize: 14 }}>Failed to load image</span>
        ) : (
          <img
            src={imgSrc ?? undefined}
            alt={name}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "92vw", maxHeight: "85vh", borderRadius: 10, objectFit: "contain", cursor: "default" }}
          />
        )}
        {nameLabel}
      </div>
    );
  }

  if (tag === "video") {
    const videoSrc = storageRef ? attachmentBlobUrl : url;
    return (
      <div onClick={onClose} style={overlayStyle}>
        {closeBtn}
        {attachmentLoading && storageRef ? (
          <span style={{ color: "#9ca3af", fontSize: 14 }}>Loading video…</span>
        ) : attachmentFailed && storageRef ? (
          <span style={{ color: "#f87171", fontSize: 14 }}>Failed to load video</span>
        ) : (
          <video
            src={videoSrc ?? undefined}
            controls
            autoPlay
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "92vw", maxHeight: "85vh", borderRadius: 10, cursor: "default" }}
          />
        )}
        {nameLabel}
      </div>
    );
  }

  if (tag === "pdf") {
    return (
      <div onClick={onClose} style={overlayStyle}>
        {closeBtn}
        {pdfLoading ? (
          <span style={{ color: "#9ca3af", fontSize: 14 }}>Loading PDF…</span>
        ) : pdfBlobUrl ? (
          <iframe
            src={pdfBlobUrl}
            title={name}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            style={{
              width: "90vw",
              height: "85vh",
              border: "none",
              borderRadius: 10,
              background: "#fff",
              cursor: "default",
            }}
          />
        ) : (
          <span style={{ color: "#f87171", fontSize: 14 }}>Failed to load PDF</span>
        )}
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 12 }}>
          {nameLabel}
          <a
            href={pdfBlobUrl ?? url}
            download={name}
            onClick={(e) => e.stopPropagation()}
            style={{ color: "#7fd7e6", fontSize: 12, textDecoration: "underline", cursor: "pointer" }}
          >
            Download {name} ↓
          </a>
        </div>
      </div>
    );
  }

  if (tag === "md") {
    return (
      <div onClick={onClose} style={overlayStyle}>
        {closeBtn}
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: "min(90vw, 720px)",
            maxHeight: "85vh",
            overflowY: "auto",
            background: "rgba(12,15,24,0.97)",
            backdropFilter: "blur(16px)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 12,
            padding: "28px 32px",
            cursor: "default",
            color: "#d1d5db",
            fontSize: 14,
            lineHeight: 1.7,
            fontFamily: SK.font,
          }}
        >
          {mdLoading ? (
            <span style={{ color: "#6b7280" }}>Loading…</span>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: simpleMdToHtml(mdContent ?? "") }} />
          )}
        </div>
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 12 }}>
          {nameLabel}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{ color: "#7fd7e6", fontSize: 12, textDecoration: "underline", cursor: "pointer" }}
          >
            Open raw ↗
          </a>
        </div>
      </div>
    );
  }

  return (
    <div onClick={onClose} style={overlayStyle}>
      {closeBtn}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
          padding: 32,
          background: "rgba(12,15,24,0.97)",
          backdropFilter: "blur(16px)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 12,
          cursor: "default",
        }}
      >
        <span style={{ fontSize: 48 }}>📎</span>
        <span style={{ color: "#d1d5db", fontSize: 16, fontFamily: "'DM Sans', sans-serif" }}>{name}</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            padding: "8px 20px",
            borderRadius: 8,
            background: "rgba(34,211,238,0.18)",
            border: "1px solid rgba(34,211,238,0.35)",
            color: "#c7d2fe",
            fontSize: 13,
            textDecoration: "none",
            cursor: "pointer",
          }}
        >
          Download / Open ↗
        </a>
      </div>
    </div>
  );
};

const UnreadBadge: FC<{ count: number }> = ({ count }) => {
  if (count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  return (
    <span
      style={{
        marginLeft: "auto",
        flexShrink: 0,
        minWidth: 20,
        height: 20,
        padding: "0 6px",
        borderRadius: 10,
        background: "rgba(103,232,249,0.22)",
        border: "1px solid rgba(103,232,249,0.45)",
        fontSize: 10,
        fontWeight: 700,
        color: "#7fd7e6",
        fontFamily: SK.mono,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {label}
    </span>
  );
};

/**
 * SpaceKit network messaging — DMs via the messaging node (envelope + SSE).
 * Layout and chat chrome mirror AgentHub; sidebar lists conversations with unread counts.
 */
const HermesApp: FC = () => {
  const embedded = isSpacekitEmbedded();
  const apiBase = useMemo(() => getSocialDirectoryApiBase(), []);
  const defaultMessaging = useMemo(() => getMessagingHttpBase(), []);
  const storageBase = useMemo(() => getChatAttachmentStorageBase(embedded), [embedded]);
  const messagingApiBase = useMemo(() => getMessagingWebsiteApiBase(), []);
  const isNarrow = useMessagingNarrowLayout();
  const { address: walletAddress, isConnected: walletConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [myDid, setMyDid] = useState(
    () => localStorage.getItem(LS_DID) || "did:spacekit:user:local-dev",
  );
  const [displayName, setDisplayName] = useState(() => localStorage.getItem(LS_NAME) || "");
  const [messagingUrl, setMessagingUrl] = useState(defaultMessaging);
  const [newPeerInput, setNewPeerInput] = useState("");
  const [selectedPeer, setSelectedPeer] = useState<string | null>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("peer") || null;
    } catch { return null; }
  });
  const selectedPeerRef = useRef<string | null>(null);
  selectedPeerRef.current = selectedPeer;
  const groupIdByThreadRef = useRef<Map<string, string>>(new Map());
  const rememberGroupMapping = useCallback((groupId: string, memberDids: string[]) => {
    if (!groupId || memberDids.length === 0) return;
    groupIdByThreadRef.current.set(channelThreadKey(groupId), groupId);
    groupIdByThreadRef.current.set(groupThreadKey(memberDids), groupId);
  }, []);
  const [channelMode, setChannelMode] = useState(false);
  const [channelPicks, setChannelPicks] = useState<string[]>([]);
  const [channelMemberInput, setChannelMemberInput] = useState("");
  const [channelName, setChannelName] = useState("");
  const [channelVisibility, setChannelVisibility] = useState<"public" | "private">("public");
  const [publicChannels, setPublicChannels] = useState<Array<{ id: string; name: string; description: string; visibility: string; member_dids: string[]; creator_did: string }>>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [channelInviteInput, setChannelInviteInput] = useState("");
  const [lastCreatedChannelId, setLastCreatedChannelId] = useState<string | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [generalInviteEmail, setGeneralInviteEmail] = useState("");
  const [generalInviteStatus, setGeneralInviteStatus] = useState<string | null>(null);
  const [socialFollowing, setSocialFollowing] = useState<Array<{ did: string; display_name: string }>>([]);

  const [orgs, setOrgs] = useState<Org[]>(() => {
    try { const raw = localStorage.getItem(LS_ORGS); return raw ? JSON.parse(raw) as Org[] : []; } catch { return []; }
  });
  const [activeOrgId, setActiveOrgId] = useState<string | null>(() => {
    const did = localStorage.getItem(LS_DID) || "did:spacekit:user:local-dev";
    return readActiveOrgId(did);
  });
  const activeOrg = useMemo(() => orgs.find((o) => o.id === activeOrgId) ?? null, [orgs, activeOrgId]);

  /** Thread keys backed by a registered group/org — must not collapse to 1:1 DMs. */
  const registeredGroupThreads = useMemo(() => {
    const keys = new Set<string>();
    for (const g of publicChannels) {
      if (g.id) keys.add(channelThreadKey(g.id));
    }
    for (const o of orgs) {
      if (o.groupId) keys.add(channelThreadKey(o.groupId));
    }
    return keys;
  }, [publicChannels, orgs]);
  const [showGearMenu, setShowGearMenu] = useState(false);
  const [pqKeysExpanded, setPqKeysExpanded] = useState(false);
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [chatSearch, setChatSearch] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [lightbox, setLightbox] = useState<{ tag: LightboxTag; url: string; name: string } | null>(null);

  const [chatMessage, setChatMessage] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatStatus, setChatStatus] = useState<string | null>(null);
  const [didRegistered, setDidRegistered] = useState(false);
  const identityReadyRef = useRef(false);
  const [identityReady, setIdentityReady] = useState(false);
  const [didRegStatus, setDidRegStatus] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadsState>({});
  const [unreadByPeer, setUnreadByPeer] = useState<Record<string, number>>({});
  const [blocked, setBlocked] = useState<Set<string>>(loadBlocked);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const [blockInput, setBlockInput] = useState("");
  const [publicOptIn, setPublicOptIn] = useState(false);
  const [directory, setDirectory] = useState<SocialEntry[]>([]);
  const [dirStatus, setDirStatus] = useState<string | null>(null);
  const [contactPickerKey, setContactPickerKey] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [archiveStatus, setArchiveStatus] = useState<string | null>(null);
  const archiveTimerRef = useRef<number | null>(null);
  const [e2eReady, setE2eReady] = useState(false);
  const pqKeyCache = useRef<Map<string, string>>(new Map());
  const threadsRef = useRef<ThreadsState>({});
  const messagesScrollRef = useRef<HTMLDivElement>(null);

  const msgIdRef = useRef(0);
  const nextLocalId = useCallback(
    () => `dm-${Date.now()}-${++msgIdRef.current}`,
    [],
  );

  useEffect(() => {
    let alive = true;
    void loadIdentitySnapshot().then((s) => {
      if (!alive) return;
      setMyDid(s.myDid);
      setDisplayName(s.displayName);
      setPublicOptIn(s.publicOptIn);
      setDidRegistered(s.didRegistered);
      identityReadyRef.current = true;
      setIdentityReady(true);
    });
    const unsub = subscribeIdentityChanges((s) => {
      setMyDid(s.myDid);
      setDisplayName(s.displayName);
      setPublicOptIn(s.publicOptIn);
      setDidRegistered(s.didRegistered);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!identityReadyRef.current) return;
    void persistIdentitySnapshot({ myDid });
  }, [myDid]);

  useEffect(() => {
    if (!identityReadyRef.current) return;
    void persistIdentitySnapshot({ displayName });
  }, [displayName]);

  useEffect(() => {
    if (!identityReadyRef.current) return;
    void persistIdentitySnapshot({ publicOptIn });
  }, [publicOptIn]);

  useEffect(() => {
    if (!identityReadyRef.current) return;
    void persistIdentitySnapshot({ didRegistered });
  }, [didRegistered]);

  useEffect(() => {
    saveBlocked(blocked);
  }, [blocked]);

  useEffect(() => {
    localStorage.setItem(LS_ORGS, JSON.stringify(orgs));
  }, [orgs]);
  useEffect(() => {
    if (!myDid) return;
    const key = storageKeyForDid(LS_ACTIVE_ORG, myDid);
    if (activeOrgId) localStorage.setItem(key, activeOrgId);
    else localStorage.removeItem(key);
  }, [activeOrgId, myDid]);

  useEffect(() => {
    setActiveOrgId(readActiveOrgId(myDid));
  }, [myDid]);

  useEffect(() => {
    if (activeOrgId && !orgs.some((o) => o.id === activeOrgId)) {
      setActiveOrgId(null);
    }
  }, [orgs, activeOrgId]);

  // Keep threadsRef in sync for beforeunload/interval saves.
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  // ── Hybrid restore: IndexedDB (instant local) → storage node (remote merge) ──
  useEffect(() => {
    if (!myDid) return;
    let cancelled = false;
    (async () => {
      try {
        const local = await getAllThreads(myDid);
        if (cancelled) return;
        if (Object.keys(local).length > 0) {
          setThreads((prev) => mergeThreads(prev, local));
          setArchiveStatus("Restored from local browser storage");
        }
      } catch { /* IndexedDB unavailable — continue without local cache */ }

      if (!storageBase) return;
      try {
        const remote = await loadConversationArchive(storageBase, myDid);
        if (cancelled || !remote) return;
        setThreads((prev) => {
          const merged = mergeThreads(prev, remote);
          putAllThreads(myDid, merged).catch(() => {});
          return merged;
        });
        setArchiveStatus("Synced with encrypted cloud backup");
      } catch { /* no remote archive — first use */ }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageBase]);

  // ── Persist: IndexedDB on every change, storage node periodically ──
  useEffect(() => {
    if (!myDid) return;
    const current = threadsRef.current;
    if (Object.keys(current).length === 0) return;
    putAllThreads(myDid, current).catch(() => {});
  }, [threads, myDid]);

  useEffect(() => {
    if (!myDid) return;
    const doRemoteSave = () => {
      const current = threadsRef.current;
      if (Object.keys(current).length === 0) return;
      if (storageBase) {
        saveConversationArchive(storageBase, myDid, current, messagingApiBase).catch(() => {});
      }
    };
    archiveTimerRef.current = window.setInterval(doRemoteSave, 60_000);
    const onUnload = () => {
      putAllThreads(myDid, threadsRef.current).catch(() => {});
      doRemoteSave();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      if (archiveTimerRef.current != null) window.clearInterval(archiveTimerRef.current);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [storageBase, myDid, messagingApiBase]);

  // ── Kyber E2E: init + register public key with messaging node ──
  const registerKyberPublicKey = useCallback(async () => {
    if (!isKyberInitialized()) await ensureEmbeddedKyber();
    setE2eReady(true);
    const keys = SpacekitClient.getKyberKeys();
    if (!keys?.publicKey || !messagingUrl) return;
    const b = messagingUrl.replace(/\/$/, "");
    const regUrl = b.endsWith("/api/messaging")
      ? `${b}/register-key`
      : `${b}/api/messages/register-key`;
    await fetch(regUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        did: myDid,
        publicKey: keys.publicKey,
        algorithm: keys.algorithm ?? "kyber1024",
      }),
    }).catch(() => {});

    if (apiBase && myDid) {
      const name = myDid.replace(/^did:spacekit:user:/, "");
      if (name.length >= 3 && !myDid.includes(":local-dev")) {
        const headers = await loadWebsiteAuthHeaders({ "Content-Type": "application/json" });
        await fetch(`${apiBase}/api/did/link-kyber`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            username: name,
            kyber_public_key: keys.publicKey,
          }),
        }).catch(() => {});
      }
    }
  }, [messagingUrl, myDid, apiBase]);

  useEffect(() => {
    if (!identityReady) return;
    let cancelled = false;
    (async () => {
      try {
        await registerKyberPublicKey();
      } catch { /* Kyber WASM unavailable */ }
      if (cancelled) return;
    })();
    return () => { cancelled = true; };
  }, [registerKyberPublicKey, identityReady]);

  const fetchRecipientKey = useCallback(async (did: string): Promise<string | null> => {
    const cached = pqKeyCache.current.get(normalizeDid(did));
    if (cached) return cached;
    try {
      const b = messagingUrl.replace(/\/$/, "");
      const url = b.endsWith("/api/messaging")
        ? `${b}/keys/${encodeURIComponent(did)}`
        : `${b}/api/messages/keys/${encodeURIComponent(did)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json() as { publicKey?: string };
        if (data.publicKey) {
          pqKeyCache.current.set(normalizeDid(did), data.publicKey);
          return data.publicKey;
        }
      }
      if (apiBase) {
        const name = did.replace(/^did:spacekit:user:/i, "");
        if (name.length >= 3) {
          const resolve = await fetch(`${apiBase}/api/did/resolve/${encodeURIComponent(name)}`);
          if (resolve.ok) {
            const data = await resolve.json() as {
              registration?: { kyber_public_key?: string };
            };
            const pk = data.registration?.kyber_public_key;
            if (pk) {
              pqKeyCache.current.set(normalizeDid(did), pk);
              return pk;
            }
          }
        }
      }
    } catch { /* ignore */ }
    return null;
  }, [messagingUrl, apiBase]);

  const fetchDirectory = useCallback(async () => {
    if (!apiBase) {
      setDirStatus("No social API base configured.");
      return;
    }
    setDirStatus(null);
    try {
      const res = await fetch(`${apiBase}/api/social/directory`);
      const data = (await res.json().catch(() => ({}))) as {
        entries?: SocialEntry[];
        error?: string;
      };
      if (!res.ok) {
        setDirStatus(
          data.error || `Directory request failed (${res.status}). Check API + storage.`,
        );
        return;
      }
      const entries = data.entries || [];
      // Show everyone returned by the API. Exclude only explicit public: false (legacy rows).
      setDirectory(entries.filter((e) => e.public !== false));
      const me = entries.find((e) => e.did === myDid);
      if (me) {
        const online = me.public !== false;
        setPublicOptIn(online);
        if (me.display_name) setDisplayName(me.display_name);
        void persistIdentitySnapshot({
          publicOptIn: online,
          displayName: me.display_name || displayName,
        });
      }
    } catch (e) {
      setDirStatus(e instanceof Error ? e.message : "Directory fetch failed");
    }
  }, [apiBase, myDid, displayName]);

  useEffect(() => {
    void fetchDirectory();
  }, [fetchDirectory]);

  useEffect(() => {
    if (!apiBase || !myDid) return;
    fetch(`${apiBase}/api/messaging/orgs?did=${encodeURIComponent(myDid)}`)
      .then((r) => (r.ok ? r.json() : { orgs: [] }))
      .then((data: { orgs?: Array<Record<string, unknown>> }) => {
        const rows = data.orgs ?? [];
        setOrgs(
          rows.map((o) => ({
            id: String(o.id ?? ""),
            name: String(o.name ?? ""),
            ownerDid: String(o.owner_did ?? o.ownerDid ?? ""),
            memberDids: Array.isArray(o.member_dids)
              ? (o.member_dids as string[])
              : Array.isArray(o.memberDids)
                ? (o.memberDids as string[])
                : [],
            groupId: o.group_id != null ? String(o.group_id) : o.groupId != null ? String(o.groupId) : undefined,
            createdAt: String(o.created_at ?? o.createdAt ?? new Date().toISOString()),
          })),
        );
      })
      .catch(() => {});
  }, [apiBase, myDid]);

  useEffect(() => {
    for (const o of orgs) {
      if (o.groupId && o.memberDids.length > 0) {
        rememberGroupMapping(o.groupId, o.memberDids);
      }
    }
  }, [orgs, rememberGroupMapping]);

  useEffect(() => {
    if (!apiBase || !myDid) return;
    fetch(`${apiBase}/api/social/following/${encodeURIComponent(myDid)}`)
      .then((r) => r.ok ? r.json() : { following: [] })
      .then((data) => setSocialFollowing(data.following || []))
      .catch(() => {});
  }, [apiBase, myDid]);

  // Check if current DID is registered on mount / DID change (keep cache on network errors).
  useEffect(() => {
    if (!apiBase || !myDid) return;
    const name = myDid.replace(/^did:spacekit:user:/, "");
    if (name.length < 3) {
      setDidRegistered(false);
      return;
    }
    let alive = true;
    fetch(`${apiBase}/api/did/resolve/${encodeURIComponent(name)}`)
      .then((r) => (r.ok ? r.json() : { found: false }))
      .then((data) => {
        if (!alive) return;
        const registered = Boolean(data.found && data.registration?.did === myDid);
        setDidRegistered(registered);
        if (registered) setDidRegStatus(null);
      })
      .catch(() => {
        /* keep cached didRegistered on failure */
      });
    return () => {
      alive = false;
    };
  }, [apiBase, myDid]);

  const registerDid = useCallback(async () => {
    if (!apiBase || !myDid) return;
    const name = myDid.replace(/^did:spacekit:user:/, "");
    if (name.length < 3) { setDidRegStatus("Name must be at least 3 characters"); return; }
    setChatBusy(true);
    setDidRegStatus(null);
    try {
      const body: Record<string, string | undefined> = { username: name };
      // If we have Kyber keys, include them
      const kyberKeys = localStorage.getItem("spacekit:kyber:keys:global");
      if (kyberKeys) {
        try {
          const parsed = JSON.parse(kyberKeys);
          if (parsed.publicKey) body.kyber_public_key = parsed.publicKey;
        } catch { /* ignore */ }
      }
      const res = await fetch(`${apiBase}/api/did/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setDidRegistered(true);
        void persistIdentitySnapshot({ didRegistered: true, myDid: data.did || myDid });
        const airdrop = data.airdrop_astra && data.airdrop_astra !== "0"
          ? ` — ${data.airdrop_astra} ASTRA airdropped!`
          : "";
        setDidRegStatus(`Registered: ${data.did}${airdrop}`);
        if (data.airdrop_astra && data.airdrop_astra !== "0") {
          try {
            const astraUnits = BigInt(Math.floor(parseFloat(data.airdrop_astra) * 1_000_000));
            const did = data.did || myDid;
            SpacekitClient.setBalance(did, astraUnits);
            localStorage.setItem(`spacekit:playground:nativeBalance:${did}`, astraUnits.toString());
          } catch { /* ignore parse errors */ }
        }
        void registerKyberPublicKey();
      } else if (res.status === 409) {
        setDidRegStatus("Username taken — choose another");
      } else {
        setDidRegStatus(data.error || "Registration failed");
      }
    } catch (e) {
      setDidRegStatus(e instanceof Error ? e.message : "Network error");
    } finally {
      setChatBusy(false);
    }
  }, [apiBase, myDid, registerKyberPublicKey]);

  const linkWallet = useCallback(async () => {
    if (!apiBase || !myDid || !walletAddress) return;
    const name = myDid.replace(/^did:spacekit:user:/, "");
    setChatBusy(true);
    setDidRegStatus(null);
    try {
      const message = [
        "SpaceKit DID wallet link",
        "",
        `DID: ${myDid}`,
        `Ethereum address: ${walletAddress}`,
        `Timestamp: ${Date.now()}`,
        "",
        "By signing, you prove control of this wallet and link it to your SpaceKit identity.",
      ].join("\n");
      const signature = await signMessageAsync({ message });
      const res = await fetch(`${apiBase}/api/did/link-wallet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: name,
          eth_address: walletAddress,
          wallet_signature: signature,
          signed_message: message,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setDidRegStatus(`Wallet linked: ${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`);
        localStorage.setItem("spacekit:linkedWalletAddress", walletAddress.toLowerCase());
      } else {
        setDidRegStatus(data.error || "Wallet link failed");
      }
    } catch (e) {
      setDidRegStatus(e instanceof Error ? e.message : "Signature rejected");
    } finally {
      setChatBusy(false);
    }
  }, [apiBase, myDid, walletAddress, signMessageAsync]);

  const registerPublic = useCallback(async (optInOverride?: boolean) => {
    if (!apiBase) {
      setChatStatus("Configure social API (see README) to register in directory.");
      return;
    }
    const isPublic = optInOverride ?? publicOptIn;
    setChatBusy(true);
    setChatStatus(null);
    try {
      const res = await fetch(`${apiBase}/api/social/directory/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "owner-did": myDid,
        },
        body: JSON.stringify({
          did: myDid,
          display_name: displayName || myDid,
          public: isPublic,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((j as { error?: string }).error || res.statusText);
      }
      setPublicOptIn(isPublic);
      void persistIdentitySnapshot({ publicOptIn: isPublic, displayName });
      setChatStatus(isPublic ? "Listed in public directory" : "Removed from directory");
      void fetchDirectory();
    } catch (e) {
      setChatStatus(formatUserFacingError(e, "Register failed"));
      throw e;
    } finally {
      setChatBusy(false);
    }
  }, [apiBase, myDid, displayName, publicOptIn, fetchDirectory]);

  const openPeer = useCallback((did: string) => {
    let d = did.trim();
    if (!d) return;
    const isRegisteredGroup =
      d.startsWith("channel:") ||
      (d.startsWith("group:") &&
        (groupIdByThreadRef.current.has(d) || registeredGroupThreads.has(d)));
    if (!isRegisteredGroup) {
      const dmPeer = dmPeerFromThread(d, myDid);
      if (dmPeer) d = dmPeer;
    }
    if (d.startsWith("channel:") || (d.startsWith("group:") && isRegisteredGroup)) {
      setSelectedPeer(d);
      setUnreadByPeer((prev) => ({ ...prev, [d]: 0 }));
      setThreads((prev) => ({ ...prev, [d]: prev[d] ?? [] }));
      setMobileMenuOpen(false);
      setContactPickerKey((k) => k + 1);
      return;
    }
    const legacyGroupKey = groupThreadKey([d, myDid]);
    setSelectedPeer(d);
    setUnreadByPeer((prev) => ({ ...prev, [d]: 0, [legacyGroupKey]: 0 }));
    setThreads((prev) => {
      const merged = mergeThreadMessages(prev[d], prev[legacyGroupKey]);
      if (merged.length === 0 && !prev[d] && !prev[legacyGroupKey]) {
        return { ...prev, [d]: [] };
      }
      const next = { ...prev, [d]: merged };
      if (legacyGroupKey !== d && prev[legacyGroupKey]) {
        delete next[legacyGroupKey];
      }
      return next;
    });
    setMobileMenuOpen(false);
    setContactPickerKey((k) => k + 1);
  }, [myDid, registeredGroupThreads]);

  const openOrgGroupChat = useCallback((org: Org) => {
    if (!org.groupId || org.memberDids.length === 0) return;
    rememberGroupMapping(org.groupId, org.memberDids);
    openPeer(channelThreadKey(org.groupId));
  }, [rememberGroupMapping, openPeer]);

  const deleteConversation = useCallback((peer: string) => {
    setThreads((prev) => {
      const next = { ...prev };
      delete next[peer];
      return next;
    });
    setUnreadByPeer((prev) => {
      const next = { ...prev };
      delete next[peer];
      return next;
    });
    if (selectedPeer === peer) setSelectedPeer(null);
    if (myDid) void deleteThread(myDid, peer);
  }, [selectedPeer, myDid]);

  const startChatWithInput = useCallback(async () => {
    const raw = newPeerInput.trim();
    if (!raw) {
      setChatStatus("Enter a username or DID, then Open.");
      return;
    }
    setChatBusy(true);
    setChatStatus(null);
    try {
      const resolved = await resolvePeerInput(raw, apiBase);
      if ("error" in resolved) {
        setChatStatus(resolved.error);
        return;
      }
      if (normalizeDid(resolved.did) === normalizeDid(myDid)) {
        setChatStatus("Cannot message yourself.");
        return;
      }
      if (resolved.unregistered) {
        setChatStatus(`Using ${resolved.did} (not found in DID registry — they must register to receive messages).`);
      }
      openPeer(resolved.did);
      setNewPeerInput("");
    } finally {
      setChatBusy(false);
    }
  }, [newPeerInput, openPeer, apiBase, myDid]);

  const addChannelMemberFromInput = useCallback(async () => {
    const raw = channelMemberInput.trim();
    if (!raw) return;
    setChatStatus(null);
    const resolved = await resolvePeerInput(raw, apiBase);
    if ("error" in resolved) {
      setChatStatus(resolved.error);
      return;
    }
    if (normalizeDid(resolved.did) === normalizeDid(myDid)) {
      setChatStatus("You are already in the group as creator.");
      setChannelMemberInput("");
      return;
    }
    if (channelPicks.some((d) => normalizeDid(d) === normalizeDid(resolved.did))) {
      setChannelMemberInput("");
      return;
    }
    setChannelPicks((p) => [...p, resolved.did]);
    setChannelMemberInput("");
    if (resolved.unregistered) {
      setChatStatus(`Added ${resolved.did} — not in DID registry yet; they should claim that username.`);
    }
  }, [channelMemberInput, apiBase, myDid, channelPicks]);

  useEffect(() => {
    if (!myDid) return;
    setThreads((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(prev)) {
        if (groupIdByThreadRef.current.has(key)) continue;
        if (key.startsWith("channel:")) continue;
        const dmPeer = dmPeerFromThread(key, myDid);
        if (!dmPeer) continue;
        const merged = mergeThreadMessages(next[dmPeer], next[key]);
        if (merged.length > 0 || next[dmPeer] || next[key]) {
          next[dmPeer] = merged;
        }
        if (key !== dmPeer) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- migrate legacy 2-member "group" DMs once per DID
  }, [myDid]);

  const conversationPeers = useMemo(() => {
    const keys = Object.keys(threads);
    return keys.sort((a, b) => {
      const la = threads[a]?.[threads[a].length - 1]?.createdAt ?? "";
      const lb = threads[b]?.[threads[b].length - 1]?.createdAt ?? "";
      return lb.localeCompare(la);
    });
  }, [threads]);

  const filteredPeers = useMemo(() => {
    if (!chatSearch.trim()) return conversationPeers;
    const q = chatSearch.toLowerCase();
    return conversationPeers.filter((peer) => {
      const name = displayNameForDid(peer, directory).toLowerCase();
      return name.includes(q) || peer.toLowerCase().includes(q);
    });
  }, [conversationPeers, chatSearch, directory]);

  /** Directory + thread peers for quick-pick (not “online” — no presence protocol yet). */
  const contactPickerOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of directory) {
      if (e.did && e.did !== myDid) map.set(e.did, e.display_name?.trim() || e.did);
    }
    for (const did of conversationPeers) {
      if (did !== myDid && !map.has(did)) {
        map.set(did, displayNameForDid(did, directory));
      }
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [directory, conversationPeers, myDid]);

  const totalUnread = useMemo(
    () => Object.values(unreadByPeer).reduce((s, n) => s + n, 0),
    [unreadByPeer],
  );

  useEffect(() => {
    try {
      localStorage.setItem("spacekit:hermes:unreadTotal", String(totalUnread));
    } catch {
      /* ignore */
    }
    if (window.parent !== window) {
      window.parent.postMessage(
        { type: "spacekit:hermes-unread", count: totalUnread },
        window.location.origin,
      );
    }
  }, [totalUnread]);

  const currentMessages = useMemo(() => {
    if (!selectedPeer) return [];
    if (selectedPeer.startsWith("channel:") && registeredGroupThreads.has(selectedPeer)) {
      return threads[selectedPeer] ?? [];
    }
    const dmPeer = dmPeerFromThreadUnlessRegistered(selectedPeer, myDid, registeredGroupThreads);
    const key = dmPeer ?? selectedPeer;
    const legacy = groupThreadKey([key, myDid]);
    return mergeThreadMessages(threads[key], threads[legacy]);
  }, [selectedPeer, threads, myDid, registeredGroupThreads]);

  useEffect(() => {
    if (!selectedPeer) return;
    if (registeredGroupThreads.has(selectedPeer)) return;
    const dmPeer = dmPeerFromThread(selectedPeer, myDid);
    if (dmPeer && dmPeer !== selectedPeer) {
      setSelectedPeer(dmPeer);
    }
  }, [selectedPeer, myDid, registeredGroupThreads]);

  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [selectedPeer, currentMessages.length]);

  const sendChat = useCallback(async () => {
    const text = chatMessage.trim();
    const rawPeer = (selectedPeer ?? "").trim();
    if (!text || !rawPeer) {
      if (!rawPeer) setChatStatus("Select a chat or start a new conversation with a DID.");
      return;
    }
    const mappedGroupId = rawPeer.startsWith("channel:")
      ? rawPeer.slice(8)
      : rawPeer.startsWith("group:")
        ? groupIdByThreadRef.current.get(rawPeer)
        : undefined;
    const isChannelThread = rawPeer.startsWith("channel:");
    const isLegacyGroupThread = rawPeer.startsWith("group:");
    const isRegisteredGroup =
      isChannelThread ||
      (isLegacyGroupThread && (!!mappedGroupId || registeredGroupThreads.has(rawPeer)));
    const dmPeer = isRegisteredGroup ? null : dmPeerFromThread(rawPeer, myDid);
    const isGroup = isRegisteredGroup || (isLegacyGroupThread && !dmPeer);
    const threadKey = isChannelThread ? rawPeer : isGroup ? rawPeer : (dmPeer ?? rawPeer);
    if (!isGroup && normalizeDid(threadKey) === normalizeDid(myDid)) {
      setChatStatus("Cannot message yourself — confirm your DID in Settings matches this account.");
      return;
    }
    const channelMeta = mappedGroupId
      ? publicChannels.find((g) => g.id === mappedGroupId)
      : null;
    const groupDids = isGroup
      ? (channelMeta?.member_dids ?? (isLegacyGroupThread ? rawPeer.slice(6).split(",").filter(Boolean) : []))
      : [];
    const groupId = isGroup ? mappedGroupId : undefined;
    setChatBusy(true);
    setChatStatus(null);
    const localId = nextLocalId();
    const createdAt = new Date().toISOString();
    setThreads((prev) => {
      const list = prev[threadKey] ?? [];
      return {
        ...prev,
        [threadKey]: [
          ...list,
          { id: localId, role: "user" as const, content: text, createdAt },
        ].slice(-200),
      };
    });
    try {
      const url = getMessagingEnvelopeUrl(messagingUrl);
      let payloadStr = text;
      if (e2eReady && !isGroup) {
        const recipientKey = await fetchRecipientKey(threadKey);
        if (recipientKey) {
          try {
            const encrypted = await encryptWithKyber(recipientKey, new TextEncoder().encode(text));
            payloadStr = "PQ1:" + serializeEncryptedData(encrypted);
          } catch { /* fall back to plaintext */ }
        }
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            kind: "chat",
            payload: payloadStr,
            context: { did: myDid, timestamp: Date.now() },
          },
          conversation_type: isGroup ? "group" : "direct",
          ...(isGroup
            ? {
                recipient_dids: groupDids,
                ...(groupId ? { group_id: groupId } : {}),
              }
            : { recipient_did: threadKey }),
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const preview = detail.replace(/\s+/g, " ").trim().slice(0, 400);
        throw new Error(`Gateway error: ${res.status}${preview ? ` — ${preview}` : ""}`);
      }
      const sent = await res.json() as { message_id?: string };
      if (sent.message_id) {
        setThreads((prev) => {
          const list = prev[threadKey] ?? [];
          return {
            ...prev,
            [threadKey]: list.map((m) =>
              m.id === localId ? { ...m, id: sent.message_id! } : m,
            ),
          };
        });
      }
      setChatMessage("");
      setChatStatus("Sent");
    } catch (e) {
      setChatStatus(formatUserFacingError(e, "Send failed"));
      setThreads((prev) => {
        const list = prev[threadKey] ?? [];
        return {
          ...prev,
          [threadKey]: list.filter((m) => m.id !== localId),
        };
      });
    } finally {
      setChatBusy(false);
    }
  }, [chatMessage, messagingUrl, myDid, selectedPeer, nextLocalId, e2eReady, fetchRecipientKey, registeredGroupThreads, publicChannels]);

  const onComposerKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void sendChat();
      }
    },
    [sendChat],
  );

  const deleteMessage = useCallback(async (messageId: string) => {
    const rawPeer = selectedPeerRef.current;
    if (!rawPeer) return;
    const list = threadsRef.current[rawPeer];
    if (!list?.some((m) => m.id === messageId && m.role === "user")) return;

    const mappedGroupId = rawPeer.startsWith("channel:")
      ? rawPeer.slice(8)
      : rawPeer.startsWith("group:")
        ? groupIdByThreadRef.current.get(rawPeer)
        : undefined;
    const isChannelThread = rawPeer.startsWith("channel:");
    const isLegacyGroupThread = rawPeer.startsWith("group:");
    const isRegisteredGroup =
      isChannelThread ||
      (isLegacyGroupThread && (!!mappedGroupId || registeredGroupThreads.has(rawPeer)));
    const dmPeer = isRegisteredGroup ? null : dmPeerFromThread(rawPeer, myDid);
    const isGroup = isRegisteredGroup || (isLegacyGroupThread && !dmPeer);
    const threadKey = isChannelThread ? rawPeer : isGroup ? rawPeer : (dmPeer ?? rawPeer);
    const channelMeta = mappedGroupId
      ? publicChannels.find((g) => g.id === mappedGroupId)
      : null;
    const groupDids = isGroup
      ? (channelMeta?.member_dids ?? (isLegacyGroupThread ? rawPeer.slice(6).split(",").filter(Boolean) : []))
      : [];
    const groupId = isGroup ? mappedGroupId : undefined;
    const participants = isGroup
      ? [...new Set([...groupDids, myDid])]
      : [...new Set([myDid, threadKey])];

    const removeLocally = () => {
      setThreads((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          next[key] = (next[key] ?? []).filter((m) => m.id !== messageId);
        }
        return next;
      });
    };

    removeLocally();

    if (!messagingUrl) return;
    try {
      const res = await fetch(getMessagingDeleteUrl(messagingUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message_id: messageId,
          deleted_by: myDid,
          participants,
          conversation_type: isGroup ? "group" : "direct",
          group_id: groupId,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        setChatStatus(detail.trim() || `Delete failed (${res.status})`);
      }
    } catch (e) {
      setChatStatus(formatUserFacingError(e, "Delete failed"));
    }
  }, [myDid, messagingUrl, publicChannels, registeredGroupThreads]);

  const applyInboundPayload = useCallback(async (payload: Record<string, unknown>) => {
    if (payload?.type === "delete") {
      const messageId = String(payload.message_id ?? "");
      if (!messageId) return;
      setThreads((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          next[key] = (next[key] ?? []).filter((m) => m.id !== messageId);
        }
        return next;
      });
      return;
    }
    if (payload?.type !== "message") return;
    const sender = String((payload.sender as { did?: string } | undefined)?.did ?? "unknown");
    if (normalizeDid(sender) === normalizeDid(myDid)) return;
    if (blockedRef.current.has(sender)) return;
    const id = `${payload.conversation_id}:${payload.created_at}`;
    let content = String(payload.content ?? "");
    const createdAt = String(payload.created_at ?? "");
    const participants: string[] = Array.isArray(payload.participants)
      ? (payload.participants as string[])
      : [];
    const threadKey = inboundThreadKey(sender, {
      conversation_type: payload.conversation_type as string | undefined,
      group_id: payload.group_id as string | null | undefined,
      participants,
    });

    setThreads((prev) => {
      const list = prev[threadKey] ?? [];
      if (list.some((m) => m.id === id)) return prev;
      return {
        ...prev,
        [threadKey]: [...list, { id, role: "peer" as const, content, createdAt, senderDid: sender }].slice(-200),
      };
    });
    if (selectedPeerRef.current !== threadKey) {
      setUnreadByPeer((u) => ({ ...u, [threadKey]: (u[threadKey] ?? 0) + 1 }));
    }

    if (content.startsWith("PQ1:") && e2eReady) {
      try {
        const keys = SpacekitClient.getKyberKeys();
        if (keys?.secretKey) {
          const encData = deserializeEncryptedData(content.slice(4));
          const plainBytes = await decryptWithKyber(keys.secretKey, encData);
          const plain = new TextDecoder().decode(plainBytes);
          setThreads((prev) => {
            const list = prev[threadKey] ?? [];
            return {
              ...prev,
              [threadKey]: list.map((m) => (m.id === id ? { ...m, content: plain } : m)),
            };
          });
        }
      } catch { /* keep ciphertext */ }
    }

    const ts = String(payload.created_at ?? "");
    if (ts) {
      const prevSince = localStorage.getItem(inboxSinceStorageKey(myDid)) ?? "";
      if (ts > prevSince) {
        localStorage.setItem(inboxSinceStorageKey(myDid), ts);
      }
    }
  }, [myDid, e2eReady]);

  const syncInbox = useCallback(async () => {
    if (!myDid || !messagingUrl) return;
    const since = localStorage.getItem(inboxSinceStorageKey(myDid)) ?? "1970-01-01T00:00:00Z";
    const tombSince = localStorage.getItem(tombstonesSinceStorageKey(myDid)) ?? "1970-01-01T00:00:00Z";
    try {
      const b = messagingUrl.replace(/\/$/, "");
      const inboxUrl = b.endsWith("/api/messaging")
        ? `${b}/inbox?did=${encodeURIComponent(myDid)}&since=${encodeURIComponent(since)}`
        : `${b}/api/messages/inbox?did=${encodeURIComponent(myDid)}&since=${encodeURIComponent(since)}`;
      const tombUrl = b.endsWith("/api/messaging")
        ? `${b}/tombstones?since=${encodeURIComponent(tombSince)}`
        : `${b}/api/messages/tombstones?since=${encodeURIComponent(tombSince)}`;

      const [inboxRes, tombRes] = await Promise.all([fetch(inboxUrl), fetch(tombUrl)]);

      if (inboxRes.ok) {
        const data = await inboxRes.json() as { messages?: Array<Record<string, unknown>> };
        for (const msg of data.messages ?? []) {
          await applyInboundPayload(msg);
        }
      }

      if (tombRes.ok) {
        const tombData = await tombRes.json() as {
          deleted?: Array<{ message_id?: string; deleted_at?: string }>;
        };
        for (const row of tombData.deleted ?? []) {
          if (!row.message_id) continue;
          await applyInboundPayload({
            type: "delete",
            message_id: row.message_id,
            deleted_by: "",
          });
          const ts = row.deleted_at ?? "";
          if (ts) {
            const prev = localStorage.getItem(tombstonesSinceStorageKey(myDid)) ?? "";
            if (ts > prev) localStorage.setItem(tombstonesSinceStorageKey(myDid), ts);
          }
        }
      }
    } catch { /* ignore */ }
  }, [myDid, messagingUrl, applyInboundPayload]);

  useEffect(() => {
    void syncInbox();
    const poll = window.setInterval(() => { void syncInbox(); }, 15_000);
    return () => window.clearInterval(poll);
  }, [syncInbox]);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: number | null = null;

    const onMessage = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as Record<string, unknown>;
        void applyInboundPayload(payload);
      } catch {
        /* ignore */
      }
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 2500);
    };

    const connect = () => {
      if (cancelled) return;
      if (reconnectTimer != null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      es?.close();
      void syncInbox();
      const url = getMessagingStreamUrl(myDid, messagingUrl);
      const source = new EventSource(url);
      es = source;
      source.onmessage = onMessage;
      source.onerror = () => {
        source.close();
        scheduleReconnect();
      };
    };

    connect();

    const bumpOnResume = () => {
      if (document.visibilityState === "visible") connect();
    };
    document.addEventListener("visibilitychange", bumpOnResume);
    window.addEventListener("online", bumpOnResume);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", bumpOnResume);
      window.removeEventListener("online", bumpOnResume);
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [messagingUrl, myDid, applyInboundPayload, syncInbox]);

  const addBlock = useCallback(() => {
    const d = blockInput.trim();
    if (!d) return;
    setBlocked((prev) => new Set(prev).add(d));
    setBlockInput("");
  }, [blockInput]);

  const removeBlock = useCallback((did: string) => {
    setBlocked((prev) => {
      const n = new Set(prev);
      n.delete(did);
      return n;
    });
  }, []);

  const fetchPublicChannels = useCallback(async () => {
    try {
      const b = messagingUrl.replace(/\/$/, "");
      const url = b.endsWith("/api/messaging")
        ? `${b}/groups?did=${encodeURIComponent(myDid)}`
        : `${b}/api/messages/groups?did=${encodeURIComponent(myDid)}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const groups = data.groups ?? [];
      setPublicChannels(groups);
      for (const g of groups) {
        if (g.id && g.member_dids?.length) {
          rememberGroupMapping(String(g.id), g.member_dids);
        }
      }
      setThreads((prev) => {
        let next = prev;
        for (const g of groups) {
          if (g.id && g.member_dids?.length) {
            next = migrateChannelThread(next, String(g.id), g.member_dids);
          }
        }
        return next === prev ? prev : next;
      });
    } catch { /* ignore */ }
  }, [messagingUrl, myDid, rememberGroupMapping]);

  useEffect(() => { void fetchPublicChannels(); }, [fetchPublicChannels]);

  const createChannelViaApi = useCallback(async () => {
    if (channelPicks.length < 1 || !channelName.trim()) return;
    setChatBusy(true);
    try {
      const b = messagingUrl.replace(/\/$/, "");
      const url = b.endsWith("/api/messaging")
        ? `${b}/groups`
        : `${b}/api/messages/groups`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: channelName.trim(),
          creator_did: normalizeDid(myDid),
          description: "",
          visibility: channelVisibility,
          member_dids: channelPicks.map((d) => normalizeDid(d)),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const key = channelThreadKey(String(data.id ?? ""));
      if (data.id) rememberGroupMapping(String(data.id), data.member_dids ?? []);
      setThreads((prev) => migrateChannelThread(prev, String(data.id), data.member_dids ?? []));
      setLastCreatedChannelId(data.id ?? null);
      openPeer(key);
      setChannelMode(false);
      setChannelPicks([]);
      setChannelName("");
      void fetchPublicChannels();
      setChatStatus(`Group "${data.name}" created`);
    } catch (e) {
      setChatStatus(formatUserFacingError(e, "Group creation failed"));
    } finally {
      setChatBusy(false);
    }
  }, [channelPicks, channelName, channelVisibility, messagingUrl, myDid, openPeer, fetchPublicChannels, rememberGroupMapping]);

  const createOrgViaApi = useCallback(async () => {
    const name = newOrgName.trim();
    if (!name || !apiBase || !myDid) {
      if (!apiBase) setChatStatus("Configure social API to register organizations.");
      return;
    }
    setChatBusy(true);
    setChatStatus(null);
    try {
      const res = await fetch(`${apiBase}/api/messaging/orgs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "owner-did": myDid,
        },
        body: JSON.stringify({
          name,
          owner_did: myDid,
          member_dids: [myDid],
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(String(data.error ?? `HTTP ${res.status}`));
      }
      const org: Org = {
        id: String(data.id ?? safeUUID()),
        name: String(data.name ?? name),
        ownerDid: String(data.owner_did ?? myDid),
        memberDids: Array.isArray(data.member_dids)
          ? (data.member_dids as string[])
          : [myDid],
        groupId: data.group_id != null ? String(data.group_id) : undefined,
        createdAt: String(data.created_at ?? new Date().toISOString()),
      };
      setOrgs((prev) => [...prev.filter((o) => o.id !== org.id), org]);
      setActiveOrgId(org.id);
      openOrgGroupChat(org);
      void fetchPublicChannels();
      setNewOrgName("");
      setShowCreateOrg(false);
      setChatStatus(`Organization "${org.name}" registered`);
    } catch (e) {
      setChatStatus(formatUserFacingError(e, "Organization registration failed"));
    } finally {
      setChatBusy(false);
    }
  }, [apiBase, myDid, newOrgName, openOrgGroupChat, fetchPublicChannels]);

  const joinChannelViaApi = useCallback(async (groupId: string, memberDids: string[]) => {
    setChatBusy(true);
    try {
      const b = messagingUrl.replace(/\/$/, "");
      const url = b.endsWith("/api/messaging")
        ? `${b}/groups/${encodeURIComponent(groupId)}/join`
        : `${b}/api/messages/groups/${encodeURIComponent(groupId)}/join`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ did: myDid }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rememberGroupMapping(groupId, [...memberDids, myDid]);
      const key = channelThreadKey(groupId);
      setThreads((prev) => migrateChannelThread(prev, groupId, [...memberDids, myDid]));
      openPeer(key);
      void fetchPublicChannels();
      setChatStatus("Joined group");
    } catch (e) {
      setChatStatus(formatUserFacingError(e, "Join failed"));
    } finally {
      setChatBusy(false);
    }
  }, [messagingUrl, myDid, openPeer, fetchPublicChannels, rememberGroupMapping]);

  const sendChannelInviteEmail = useCallback(async (groupId: string, channelNameStr: string, email: string) => {
    if (!email.trim()) return;
    try {
      const res = await fetch(`${apiBase}/api/social/groups/${groupId}/invite-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviter_did: myDid, invitee_email: email.trim(), group_name: channelNameStr }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setChatStatus(`Invite sent to ${email.trim()}`);
      setInviteEmail("");
    } catch (e) {
      setChatStatus(formatUserFacingError(e, "Invite failed"));
    }
  }, [apiBase, myDid]);

  const inviteMemberToChannel = useCallback(async (groupId: string, rawInput: string, channelNameStr?: string) => {
    const raw = rawInput.trim();
    if (!raw) {
      setChatStatus("Enter a username (e.g. alice or @alice) to invite.");
      return;
    }
    setChatBusy(true);
    setChatStatus(null);
    try {
      const resolved = await resolvePeerInput(raw, apiBase);
      if ("error" in resolved) {
        setChatStatus(resolved.error);
        return;
      }
      if (normalizeDid(resolved.did) === normalizeDid(myDid)) {
        setChatStatus("Cannot invite yourself.");
        return;
      }
      const b = messagingUrl.replace(/\/$/, "");
      const url = b.endsWith("/api/messaging")
        ? `${b}/groups/${encodeURIComponent(groupId)}/invite`
        : `${b}/api/messages/groups/${encodeURIComponent(groupId)}/invite`;
      const inviterDid = normalizeDid(myDid);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "owner-did": inviterDid,
        },
        body: JSON.stringify({ did: resolved.did, inviter_did: inviterDid }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        if (res.status === 403) {
          throw new Error(
            data.error
              ?? "Invite forbidden — you must be a channel member. Restart website-api if you recently updated.",
          );
        }
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setChannelInviteInput("");
      void fetchPublicChannels();
      setChatStatus(`Invited ${resolved.did.split(":").pop() ?? resolved.did} to ${channelNameStr ?? "channel"}`);
    } catch (e) {
      setChatStatus(formatUserFacingError(e, "Invite failed"));
    } finally {
      setChatBusy(false);
    }
  }, [apiBase, myDid, messagingUrl, fetchPublicChannels]);

  const deleteChannelViaApi = useCallback(async (groupId: string, channelNameStr: string, threadKey?: string) => {
    if (!confirm(`Delete channel "${channelNameStr}"? This cannot be undone.`)) return;
    setChatBusy(true);
    try {
      const b = messagingUrl.replace(/\/$/, "");
      const url = b.endsWith("/api/messaging")
        ? `${b}/groups/${encodeURIComponent(groupId)}`
        : `${b}/api/messages/groups/${encodeURIComponent(groupId)}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: { "owner-did": myDid },
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (threadKey) deleteConversation(threadKey);
      else deleteConversation(channelThreadKey(groupId));
      void fetchPublicChannels();
      setChatStatus(`Channel "${channelNameStr}" deleted`);
    } catch (e) {
      setChatStatus(formatUserFacingError(e, "Delete failed"));
    } finally {
      setChatBusy(false);
    }
  }, [messagingUrl, myDid, deleteConversation, fetchPublicChannels, publicChannels]);

  const selectedChannelMeta = useMemo(() => {
    if (!selectedPeer) return null;
    return channelMetaForThread(selectedPeer, publicChannels);
  }, [selectedPeer, publicChannels]);

  const isActiveGroupChannel = useMemo(() => {
    return Boolean(selectedPeer?.startsWith("channel:") && registeredGroupThreads.has(selectedPeer ?? ""));
  }, [selectedPeer, registeredGroupThreads]);

  return (
    <div className={`messaging-hub-root${embedded ? " messaging-hub-root--embedded" : ""}${isNarrow && mobileMenuOpen ? " messaging-hub-root--mobile-drawer-open" : ""}`}>
      <style>{`
        .messaging-hub-root ::-webkit-scrollbar { width: 4px; }
        .messaging-hub-root ::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.1);
          border-radius: 4px;
        }
        .messaging-messages-scroll::-webkit-scrollbar { width: 8px; }
        .messaging-messages-scroll::-webkit-scrollbar-thumb {
          background: rgba(103,232,249,0.35);
          border-radius: 4px;
        }
        .messaging-messages-scroll {
          flex: 1 1 0%;
          min-height: 0;
          overflow-x: hidden;
          overflow-y: auto;
          overscroll-behavior: auto;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: auto;
          scrollbar-color: rgba(103, 232, 249, 0.4) rgba(0, 0, 0, 0.25);
        }
        .messaging-hub-root textarea:focus { outline: none; }
      `}</style>

      {isNarrow ? (
        <header
          style={{
            flexShrink: 0,
            padding: "10px 14px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(12px)",
          }}
        >
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            style={{
              all: "unset",
              cursor: "pointer",
              padding: "6px 10px",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              color: "#9ca3af",
              fontFamily: SK.font,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.03)",
              touchAction: "manipulation",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            ☰
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                margin: 0,
                fontSize: 15,
                fontWeight: 700,
                color: "#f9fafb",
                fontFamily: SK.font,
              }}
            >
              Messaging
            </div>
            {selectedPeer ? (
              <p
                style={{
                  margin: "2px 0 0",
                  fontSize: 10,
                  color: "#6b7280",
                  fontFamily: SK.mono,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {displayNameForDid(selectedPeer, directory)}
              </p>
            ) : null}
          </div>
          {totalUnread > 0 ? <UnreadBadge count={totalUnread} /> : null}
        </header>
      ) : null}

      {isNarrow && mobileMenuOpen ? (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setMobileMenuOpen(false)}
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            top: MESSAGING_MOBILE_OVERLAY_TOP,
            bottom: 0,
            zIndex: 40,
            margin: 0,
            padding: 0,
            border: "none",
            background: "rgba(0,0,0,0.5)",
            cursor: "pointer",
            WebkitTapHighlightColor: "transparent",
          }}
        />
      ) : null}

      <div
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          display: "flex",
          width: "100%",
        }}
      >
        <aside
          aria-label="Conversations and settings"
          style={{
            position: isNarrow ? "fixed" : "absolute",
            left: 0,
            top: isNarrow ? MESSAGING_MOBILE_OVERLAY_TOP : 0,
            bottom: 0,
            width: MESSAGING_SIDEBAR_PX,
            maxWidth: "min(100vw - 48px, 320px)",
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            borderRight: "1px solid rgba(255,255,255,0.06)",
            background: "rgba(10,13,18,0.85)",
            backdropFilter: "blur(12px)",
            zIndex: isNarrow ? 45 : undefined,
            transform: isNarrow && !mobileMenuOpen ? "translate3d(-100%, 0, 0)" : undefined,
            transition: isNarrow ? "transform 0.2s ease" : undefined,
            boxShadow: isNarrow && mobileMenuOpen ? "8px 0 32px rgba(0,0,0,0.45)" : undefined,
            pointerEvents: isNarrow && !mobileMenuOpen ? "none" : "auto",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          {isNarrow ? (
            <div
              style={{
                flexShrink: 0,
                display: "flex",
                justifyContent: "flex-end",
                padding: "6px 8px 0",
              }}
            >
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setMobileMenuOpen(false)}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  fontSize: 22,
                  lineHeight: 1,
                  color: "#6b7280",
                  padding: "4px 10px",
                  fontFamily: SK.font,
                }}
              >
                ×
              </button>
            </div>
          ) : null}

          {/* ── Org strip + sidebar panel ── */}
          <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
            {/* Org strip column */}
            <div
              style={{
                width: 36,
                flexShrink: 0,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                padding: "10px 0",
                borderRight: "1px solid rgba(255,255,255,0.06)",
                background: "rgba(0,0,0,0.15)",
              }}
            >
              <button
                type="button"
                onClick={() => setActiveOrgId(null)}
                title="Personal"
                style={{
                  all: "unset",
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: SK.mono,
                  color: activeOrgId === null ? "#080b0f" : "#7fd7e6",
                  background: activeOrgId === null ? "#7fd7e6" : "rgba(103,232,249,0.1)",
                  border: `1px solid ${activeOrgId === null ? "#7fd7e6" : "rgba(103,232,249,0.25)"}`,
                  touchAction: "manipulation",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                P
              </button>
              {orgs.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => {
                    setActiveOrgId(o.id);
                    openOrgGroupChat(o);
                  }}
                  title={o.name}
                  style={{
                    all: "unset",
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: SK.mono,
                    color: activeOrgId === o.id ? "#080b0f" : "#7fd7e6",
                    background: activeOrgId === o.id ? "#7fd7e6" : "rgba(103,232,249,0.1)",
                    border: `1px solid ${activeOrgId === o.id ? "#7fd7e6" : "rgba(103,232,249,0.25)"}`,
                    touchAction: "manipulation",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  {o.name.charAt(0).toUpperCase()}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setShowCreateOrg(true)}
                title="Create org"
                style={{
                  all: "unset",
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  fontSize: 16,
                  color: "#6b7280",
                  border: "1px dashed rgba(255,255,255,0.15)",
                  touchAction: "manipulation",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                +
              </button>
            </div>

            {/* Main sidebar panel */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
              {/* User header */}
              <div
                style={{
                  padding: "12px 12px 10px",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: "#f9fafb",
                    fontFamily: SK.font,
                    marginBottom: 4,
                  }}
                >
                  {activeOrg?.name ?? "Personal"}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      fontSize: 12,
                      color: "#d1d5db",
                      fontFamily: SK.font,
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {displayName || "Anonymous"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowGearMenu(true)}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      fontSize: 14,
                      color: "#6b7280",
                      padding: 2,
                      touchAction: "manipulation",
                      WebkitTapHighlightColor: "transparent",
                    }}
                  >
                    ⚙
                  </button>
                </div>
                <button
                  type="button"
                  disabled={chatBusy || !apiBase}
                  onClick={async () => {
                    if (!apiBase || !myDid) return;
                    const goingOnline = !publicOptIn;
                    setPublicOptIn(goingOnline);
                    setChatBusy(true);
                    try {
                      await registerPublic(goingOnline);
                      setDirStatus(goingOnline ? "You're discoverable in the directory" : "You're private — you can still receive DMs");
                      void fetchDirectory();
                    } catch {
                      setPublicOptIn(!goingOnline);
                      setDirStatus("Failed to update status");
                    } finally {
                      setChatBusy(false);
                    }
                  }}
                  style={{
                    all: "unset",
                    cursor: apiBase && !chatBusy ? "pointer" : "default",
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    marginTop: 4,
                    fontSize: 10,
                    fontFamily: SK.font,
                    color: publicOptIn ? "#34d399" : "#6b7280",
                    touchAction: "manipulation",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  <span style={{ fontSize: 8 }}>{publicOptIn ? "●" : "○"}</span>
                  {publicOptIn ? "Discoverable" : "Private"}
                </button>
                {dirStatus ? (
                  <p style={{ margin: "4px 0 0", fontSize: 9, color: "#f43f5e" }}>{dirStatus}</p>
                ) : null}
              </div>

              {/* Search + actions */}
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                  flexShrink: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <input
                  value={chatSearch}
                  onChange={(e) => setChatSearch(e.target.value)}
                  placeholder="Search chats…"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "7px 10px",
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(0,0,0,0.25)",
                    color: "#e5e7eb",
                    fontSize: 11,
                    fontFamily: SK.font,
                  }}
                />
                <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                  <button
                    type="button"
                    onClick={() => setShowNewChat((v) => !v)}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      flex: 1,
                      minWidth: 0,
                      padding: "7px 10px",
                      borderRadius: 8,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: SK.font,
                      color: showNewChat ? "#080b0f" : "#7fd7e6",
                      background: showNewChat ? "#7fd7e6" : "rgba(103,232,249,0.1)",
                      border: `1px solid ${showNewChat ? "#7fd7e6" : "rgba(103,232,249,0.25)"}`,
                      touchAction: "manipulation",
                      WebkitTapHighlightColor: "transparent",
                    }}
                  >
                    New Message
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowInviteModal(true)}
                    title="Invite someone to SpaceKit"
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      padding: "7px 12px",
                      borderRadius: 8,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: SK.font,
                      color: "#c4b5fd",
                      background: "rgba(168,85,247,0.1)",
                      border: "1px solid rgba(168,85,247,0.25)",
                      touchAction: "manipulation",
                      WebkitTapHighlightColor: "transparent",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Invite
                  </button>
                </div>
              </div>

              {/* New chat inline panel */}
              {showNewChat && (
                <div
                  style={{
                    padding: "10px 12px",
                    borderBottom: "1px solid rgba(255,255,255,0.05)",
                    flexShrink: 0,
                  }}
                >
                  {!channelMode ? (
                    <>
                      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                        <input
                          value={newPeerInput}
                          onChange={(e) => setNewPeerInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              startChatWithInput();
                            }
                          }}
                          placeholder="Username or DID (e.g. alice)"
                          style={{
                            flex: 1,
                            minWidth: 0,
                            padding: "8px 10px",
                            borderRadius: 8,
                            border: "1px solid rgba(255,255,255,0.08)",
                            background: "rgba(0,0,0,0.25)",
                            color: "#e5e7eb",
                            fontSize: 11,
                            fontFamily: SK.mono,
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => startChatWithInput()}
                          style={{
                            all: "unset",
                            cursor: "pointer",
                            padding: "8px 12px",
                            borderRadius: 8,
                            fontSize: 12,
                            fontWeight: 600,
                            color: "#080b0f",
                            background: "#7fd7e6",
                            fontFamily: SK.font,
                            touchAction: "manipulation",
                            WebkitTapHighlightColor: "transparent",
                          }}
                        >
                          Open
                        </button>
                      </div>
                      <select
                        key={contactPickerKey}
                        defaultValue=""
                        aria-label="Pick a known contact"
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v) openPeer(v);
                        }}
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          padding: "8px 10px",
                          borderRadius: 8,
                          border: "1px solid rgba(255,255,255,0.1)",
                          background: "rgba(0,0,0,0.35)",
                          color: "#e5e7eb",
                          fontSize: 12,
                          fontFamily: SK.font,
                        }}
                      >
                        <option value="" disabled>
                          Pick a known contact…
                        </option>
                        {contactPickerOptions.map(([did, label]) => (
                          <option key={did} value={did}>
                            {label} — {did.length > 36 ? `${did.slice(0, 18)}…` : did}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          setChannelMode(true);
                          setChannelPicks([]);
                          setChannelName("");
                          setLastCreatedChannelId(null);
                        }}
                        style={{
                          all: "unset",
                          display: "block",
                          width: "100%",
                          marginTop: 8,
                          padding: "6px 0",
                          borderRadius: 8,
                          textAlign: "center",
                          cursor: "pointer",
                          border: "1px solid rgba(255,255,255,0.08)",
                          fontSize: 11,
                          color: "#9ca3af",
                          fontFamily: SK.font,
                        }}
                      >
                        New channel…
                      </button>
                    </>
                  ) : (
                    <>
                      <input
                        value={channelName}
                        onChange={(e) => setChannelName(e.target.value)}
                        placeholder="Channel name"
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          padding: "8px 10px",
                          borderRadius: 8,
                          border: "1px solid rgba(255,255,255,0.08)",
                          background: "rgba(0,0,0,0.35)",
                          color: "#e5e7eb",
                          fontSize: 12,
                          fontFamily: SK.font,
                          marginBottom: 6,
                        }}
                      />
                      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                        {(["public", "private"] as const).map((v) => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => setChannelVisibility(v)}
                            style={{
                              all: "unset",
                              flex: 1,
                              padding: "6px 0",
                              borderRadius: 6,
                              textAlign: "center",
                              fontSize: 10,
                              fontWeight: 600,
                              cursor: "pointer",
                              fontFamily: SK.font,
                              border: `1px solid ${channelVisibility === v ? "rgba(103,232,249,0.4)" : "rgba(255,255,255,0.08)"}`,
                              background: channelVisibility === v ? "rgba(103,232,249,0.1)" : "transparent",
                              color: channelVisibility === v ? "#7fd7e6" : "#6b7280",
                            }}
                          >
                            {v === "public" ? "Public" : "Private"}
                          </button>
                        ))}
                      </div>
                      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                        <input
                          value={channelMemberInput}
                          onChange={(e) => setChannelMemberInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void addChannelMemberFromInput();
                            }
                          }}
                          placeholder="Add by username (e.g. alice)"
                          style={{
                            flex: 1,
                            minWidth: 0,
                            padding: "8px 10px",
                            borderRadius: 8,
                            border: "1px solid rgba(255,255,255,0.08)",
                            background: "rgba(0,0,0,0.25)",
                            color: "#e5e7eb",
                            fontSize: 11,
                            fontFamily: SK.mono,
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => { void addChannelMemberFromInput(); }}
                          style={{
                            all: "unset",
                            cursor: "pointer",
                            padding: "8px 12px",
                            borderRadius: 8,
                            fontSize: 12,
                            fontWeight: 600,
                            color: "#080b0f",
                            background: "#7fd7e6",
                            fontFamily: SK.font,
                          }}
                        >
                          Add
                        </button>
                      </div>
                      <select
                        defaultValue=""
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v && !channelPicks.includes(v)) setChannelPicks((p) => [...p, v]);
                        }}
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          padding: "10px 10px",
                          borderRadius: 8,
                          border: "1px solid rgba(255,255,255,0.1)",
                          background: "rgba(0,0,0,0.35)",
                          color: "#e5e7eb",
                          fontSize: 12,
                          fontFamily: SK.font,
                        }}
                      >
                        <option value="">Add member…</option>
                        {contactPickerOptions
                          .filter(([did]) => !channelPicks.includes(did))
                          .map(([did, label]) => (
                            <option key={did} value={did}>
                              {label}
                            </option>
                          ))}
                      </select>
                      {channelPicks.length > 0 && (
                        <div style={{ marginTop: 8 }}>
                          {channelPicks.map((d) => (
                            <div
                              key={d}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                fontSize: 10,
                                color: "#e5e7eb",
                                marginBottom: 4,
                                fontFamily: SK.mono,
                              }}
                            >
                              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {displayNameForDid(d, directory)}
                              </span>
                              <button
                                type="button"
                                onClick={() => setChannelPicks((p) => p.filter((x) => x !== d))}
                                style={{ all: "unset", cursor: "pointer", color: "#f43f5e", fontSize: 10 }}
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      <button
                        type="button"
                        disabled={channelPicks.length < 1 || !channelName.trim() || chatBusy}
                        onClick={() => void createChannelViaApi()}
                        style={{
                          all: "unset",
                          display: "block",
                          width: "100%",
                          boxSizing: "border-box",
                          marginTop: 8,
                          padding: "8px 0",
                          borderRadius: 8,
                          textAlign: "center",
                          cursor: channelPicks.length >= 1 && channelName.trim() && !chatBusy ? "pointer" : "not-allowed",
                          opacity: channelPicks.length >= 1 && channelName.trim() && !chatBusy ? 1 : 0.5,
                          background: "rgba(103,232,249,0.08)",
                          border: "1px solid rgba(103,232,249,0.2)",
                          fontSize: 12,
                          fontWeight: 600,
                          color: "#7fd7e6",
                          fontFamily: SK.font,
                        }}
                      >
                        {chatBusy ? "Creating…" : `Create ${channelVisibility} channel (${channelPicks.length} members)`}
                      </button>
                      {lastCreatedChannelId && (
                        <div style={{ marginTop: 10 }}>
                          <p style={{ margin: "0 0 4px", fontSize: 9, color: "#94a3b8", fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.08em" }}>
                            INVITE ON NETWORK
                          </p>
                          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                            <input
                              value={channelInviteInput}
                              onChange={(e) => setChannelInviteInput(e.target.value)}
                              placeholder="@alice or did:…"
                              style={{
                                flex: 1,
                                minWidth: 0,
                                padding: "6px 8px",
                                borderRadius: 6,
                                border: "1px solid rgba(255,255,255,0.08)",
                                background: "rgba(0,0,0,0.35)",
                                color: "#e5e7eb",
                                fontSize: 11,
                                fontFamily: SK.font,
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => void inviteMemberToChannel(lastCreatedChannelId, channelInviteInput, channelName)}
                              disabled={!channelInviteInput.trim() || chatBusy}
                              style={{
                                all: "unset",
                                padding: "6px 12px",
                                borderRadius: 6,
                                fontSize: 11,
                                fontWeight: 600,
                                cursor: channelInviteInput.trim() && !chatBusy ? "pointer" : "not-allowed",
                                opacity: channelInviteInput.trim() && !chatBusy ? 1 : 0.5,
                                border: "1px solid rgba(103,232,249,0.2)",
                                background: "rgba(103,232,249,0.06)",
                                color: "#7fd7e6",
                                fontFamily: SK.font,
                              }}
                            >
                              Invite
                            </button>
                          </div>
                          {channelVisibility === "private" && (
                            <>
                              <p style={{ margin: "0 0 4px", fontSize: 9, color: "#94a3b8", fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.08em" }}>
                                INVITE BY EMAIL
                              </p>
                              <div style={{ display: "flex", gap: 6 }}>
                                <input
                                  value={inviteEmail}
                                  onChange={(e) => setInviteEmail(e.target.value)}
                                  placeholder="user@example.com"
                                  style={{
                                    flex: 1,
                                    minWidth: 0,
                                    padding: "6px 8px",
                                    borderRadius: 6,
                                    border: "1px solid rgba(255,255,255,0.08)",
                                    background: "rgba(0,0,0,0.35)",
                                    color: "#e5e7eb",
                                    fontSize: 11,
                                    fontFamily: SK.font,
                                  }}
                                />
                                <button
                                  type="button"
                                  onClick={() => void sendChannelInviteEmail(lastCreatedChannelId, channelName, inviteEmail)}
                                  disabled={!inviteEmail.trim()}
                                  style={{
                                    all: "unset",
                                    padding: "6px 12px",
                                    borderRadius: 6,
                                    fontSize: 11,
                                    fontWeight: 600,
                                    cursor: inviteEmail.trim() ? "pointer" : "not-allowed",
                                    opacity: inviteEmail.trim() ? 1 : 0.5,
                                    border: "1px solid rgba(103,232,249,0.2)",
                                    background: "rgba(103,232,249,0.06)",
                                    color: "#7fd7e6",
                                    fontFamily: SK.font,
                                  }}
                                >
                                  Send
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setChannelMode(false);
                          setChannelPicks([]);
                          setChannelName("");
                          setLastCreatedChannelId(null);
                        }}
                        style={{
                          all: "unset",
                          display: "block",
                          width: "100%",
                          marginTop: 8,
                          padding: "6px 0",
                          borderRadius: 8,
                          textAlign: "center",
                          cursor: "pointer",
                          border: "1px solid rgba(255,255,255,0.08)",
                          fontSize: 11,
                          color: "#9ca3af",
                          fontFamily: SK.font,
                        }}
                      >
                        ← Back to DM
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* Scrollable conversation list */}
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 10px" }}>
                {/* Channels */}
                <div style={{ marginBottom: 12 }}>
                  <p
                    style={{
                      margin: "0 4px 6px",
                      fontSize: 9,
                      fontFamily: SK.mono,
                      letterSpacing: "0.1em",
                      color: SIDEBAR_SECTION_LABEL,
                    }}
                  >
                    CHANNELS
                  </p>
                </div>
                {publicChannels.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    {publicChannels.map((g) => {
                      const isMember = g.member_dids.includes(myDid);
                      const isCreator = g.creator_did === myDid;
                      const threadKey = channelThreadKey(g.id);
                      return (
                        <div
                          key={g.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 6,
                            padding: "6px 8px",
                            borderRadius: 8,
                            marginBottom: 4,
                            background: "rgba(255,255,255,0.02)",
                            border: "1px solid rgba(255,255,255,0.04)",
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: "#e5e7eb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "'DM Sans', sans-serif" }}>
                              {g.name}
                            </div>
                            <div style={{ fontSize: 9, color: "#6b7280", fontFamily: "'IBM Plex Mono', monospace" }}>
                              {g.visibility} · {g.member_dids.length} members
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                            {isMember ? (
                              <button
                                type="button"
                                onClick={() => {
                                  rememberGroupMapping(g.id, g.member_dids);
                                  openPeer(threadKey);
                                }}
                                style={{
                                  all: "unset",
                                  padding: "4px 8px",
                                  borderRadius: 6,
                                  fontSize: 10,
                                  fontWeight: 600,
                                  cursor: "pointer",
                                  border: "1px solid rgba(103,232,249,0.2)",
                                  background: "rgba(103,232,249,0.06)",
                                  color: "#7fd7e6",
                                  fontFamily: SK.font,
                                }}
                              >
                                Open
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={chatBusy}
                                onClick={() => void joinChannelViaApi(g.id, g.member_dids)}
                                style={{
                                  all: "unset",
                                  padding: "4px 8px",
                                  borderRadius: 6,
                                  fontSize: 10,
                                  fontWeight: 600,
                                  cursor: chatBusy ? "not-allowed" : "pointer",
                                  opacity: chatBusy ? 0.5 : 1,
                                  border: "1px solid rgba(103,232,249,0.2)",
                                  background: "rgba(103,232,249,0.06)",
                                  color: "#7fd7e6",
                                  fontFamily: SK.font,
                                }}
                              >
                                Join
                              </button>
                            )}
                            {isCreator && (
                              <button
                                type="button"
                                title="Delete channel"
                                disabled={chatBusy}
                                onClick={() => void deleteChannelViaApi(g.id, g.name, threadKey)}
                                style={{
                                  all: "unset",
                                  padding: "4px 8px",
                                  borderRadius: 6,
                                  fontSize: 10,
                                  fontWeight: 600,
                                  cursor: chatBusy ? "not-allowed" : "pointer",
                                  opacity: chatBusy ? 0.5 : 1,
                                  border: "1px solid rgba(244,63,94,0.25)",
                                  background: "rgba(244,63,94,0.08)",
                                  color: "#f87171",
                                  fontFamily: SK.font,
                                }}
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Following */}
                {socialFollowing.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <p
                      style={{
                        margin: "0 4px 6px",
                        fontSize: 9,
                        fontFamily: SK.mono,
                        letterSpacing: "0.1em",
                        color: SIDEBAR_SECTION_LABEL,
                      }}
                    >
                      FOLLOWING · {socialFollowing.length}
                    </p>
                    {socialFollowing.map((f) => (
                      <button
                        key={f.did}
                        type="button"
                        onClick={() => openPeer(f.did)}
                        style={{
                          all: "unset",
                          display: "flex",
                          width: "100%",
                          boxSizing: "border-box",
                          padding: "6px 10px",
                          borderRadius: 8,
                          marginBottom: 3,
                          cursor: "pointer",
                          background: selectedPeer === f.did ? "rgba(103,232,249,0.07)" : "transparent",
                          alignItems: "center",
                          gap: 8,
                          touchAction: "manipulation",
                          WebkitTapHighlightColor: "transparent",
                        }}
                      >
                        <PeerAvatar did={f.did} />
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: 12,
                            fontWeight: 500,
                            color: "#d1d5db",
                            fontFamily: SK.font,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {f.display_name || f.did.split(":").pop()}
                        </span>
                        <a
                          href={`/profile/${encodeURIComponent(f.did)}`}
                          onClick={(e) => { e.stopPropagation(); }}
                          style={{ fontSize: 11, color: "#7fd7e6", textDecoration: "none", flexShrink: 0 }}
                          title="View profile"
                        >
                          ↗
                        </a>
                      </button>
                    ))}
                  </div>
                )}

                {/* Messages */}
                <p
                  style={{
                    margin: "0 4px 8px",
                    fontSize: 9,
                    fontFamily: SK.mono,
                    letterSpacing: "0.1em",
                    color: SIDEBAR_SECTION_LABEL,
                  }}
                >
                  MESSAGES · {filteredPeers.length}
                </p>
                {filteredPeers.length === 0 ? (
                  <p style={{ margin: "8px 4px", fontSize: 11, color: "#6b7280", lineHeight: 1.5 }}>
                    No threads yet. Open a DID above or wait for an inbound message.
                  </p>
                ) : (
                  filteredPeers.map((peer) => {
                    const unread = unreadByPeer[peer] ?? 0;
                    const selected = selectedPeer === peer;
                    const last = threads[peer]?.[threads[peer].length - 1];
                    const channelMeta = channelMetaForThread(peer, publicChannels);
                    const isGroupThread = peer.startsWith("group:") || peer.startsWith("channel:");
                    const peerLabel = channelMeta
                      ? `# ${channelMeta.name}`
                      : isGroupThread
                        ? peer
                            .slice(6)
                            .split(",")
                            .map((d) => displayNameForDid(d, directory))
                            .join(", ")
                        : displayNameForDid(peer, directory);
                    return (
                      <button
                        key={peer}
                        type="button"
                        onClick={() => openPeer(peer)}
                        style={{
                          all: "unset",
                          display: "flex",
                          width: "100%",
                          boxSizing: "border-box",
                          padding: "10px 12px",
                          borderRadius: 10,
                          marginBottom: 4,
                          cursor: "pointer",
                          background: selected ? "rgba(103,232,249,0.07)" : "rgba(255,255,255,0.025)",
                          border: `1px solid ${selected ? "rgba(103,232,249,0.3)" : "rgba(255,255,255,0.06)"}`,
                          alignItems: "flex-start",
                          gap: 8,
                          touchAction: "manipulation",
                          WebkitTapHighlightColor: "transparent",
                        }}
                      >
                        <PeerAvatar did={peer} />
                        <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                          <p
                            style={{
                              margin: 0,
                              fontSize: 13,
                              fontWeight: 600,
                              color: selected ? "#d1fae5" : "#e5e7eb",
                              fontFamily: SK.font,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {isGroupThread ? `👥 ${peerLabel}` : peerLabel}
                          </p>
                          {last ? (
                            <p
                              style={{
                                margin: "4px 0 0",
                                fontSize: 11,
                                color: "#52525b",
                                fontFamily: SK.font,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {last.role === "user" ? "You: " : ""}
                              {last.content.slice(0, 80)}
                              {last.content.length > 80 ? "…" : ""}
                            </p>
                          ) : null}
                        </div>
                        <UnreadBadge count={unread} />
                        <span
                          role="button"
                          tabIndex={0}
                          title="Delete conversation"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Delete conversation with ${peerLabel}?`)) deleteConversation(peer);
                          }}
                          style={{
                            fontSize: 12,
                            color: "#52525b",
                            cursor: "pointer",
                            padding: "2px 4px",
                            borderRadius: 4,
                            flexShrink: 0,
                            opacity: 0.5,
                            transition: "opacity 0.15s",
                          }}
                          onMouseEnter={(e) => { (e.target as HTMLElement).style.opacity = "1"; }}
                          onMouseLeave={(e) => { (e.target as HTMLElement).style.opacity = "0.5"; }}
                        >
                          ✕
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* ── Invite modal ── */}
          {showInviteModal && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 100,
                background: "rgba(0,0,0,0.6)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              onClick={() => setShowInviteModal(false)}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: "min(90vw, 420px)",
                  padding: "24px 28px",
                  borderRadius: 16,
                  background: "rgba(12,15,24,0.97)",
                  backdropFilter: "blur(16px)",
                  border: "1px solid rgba(168,85,247,0.25)",
                }}
              >
                <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 700, color: "#e5e7eb" }}>
                  Invite to SpaceKit
                </h3>
                <p style={{ margin: "0 0 16px", fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>
                  Send an email invitation to join SpaceKit. They'll receive a link to create their DID and start messaging.
                </p>
                <input
                  value={generalInviteEmail}
                  onChange={(e) => setGeneralInviteEmail(e.target.value)}
                  placeholder="friend@example.com"
                  type="email"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "10px 14px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(0,0,0,0.25)",
                    color: "#e5e7eb",
                    fontSize: 13,
                    marginBottom: 12,
                  }}
                />
                {activeOrg && (
                  <p style={{ margin: "0 0 12px", fontSize: 11, color: "#a78bfa" }}>
                    Inviting to org: {activeOrg.name}
                  </p>
                )}
                {generalInviteStatus && (
                  <p style={{ margin: "0 0 12px", fontSize: 11, color: generalInviteStatus.includes("Sent") ? "#34d399" : "#f87171" }}>
                    {generalInviteStatus}
                  </p>
                )}
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() => { setShowInviteModal(false); setGeneralInviteEmail(""); setGeneralInviteStatus(null); }}
                    style={{
                      all: "unset", padding: "8px 16px", borderRadius: 8, cursor: "pointer",
                      fontSize: 12, fontWeight: 600, color: "#6b7280",
                      border: "1px solid rgba(255,255,255,0.06)",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!generalInviteEmail.includes("@")}
                    onClick={async () => {
                      setGeneralInviteStatus(null);
                      try {
                        const res = await fetch(`${apiBase}/api/social/invite-email`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            inviter_did: myDid,
                            inviter_name: displayName || myDid.split(":").pop() || myDid,
                            invitee_email: generalInviteEmail.trim(),
                            org_name: activeOrg?.name,
                          }),
                        });
                        if (res.ok) {
                          setGeneralInviteStatus("Sent! They'll get an email shortly.");
                          setGeneralInviteEmail("");
                        } else {
                          const data = await res.json().catch(() => ({})) as { error?: string };
                          setGeneralInviteStatus(data.error || "Failed to send invitation");
                        }
                      } catch {
                        setGeneralInviteStatus("Network error");
                      }
                    }}
                    style={{
                      all: "unset", padding: "8px 20px", borderRadius: 8, cursor: generalInviteEmail.includes("@") ? "pointer" : "default",
                      fontSize: 12, fontWeight: 700, color: "#a78bfa",
                      background: "rgba(168,85,247,0.15)",
                      border: "1px solid rgba(168,85,247,0.3)",
                      opacity: generalInviteEmail.includes("@") ? 1 : 0.5,
                    }}
                  >
                    Send invite
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Gear menu overlay ── */}
          {showGearMenu && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 100,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <button
                type="button"
                aria-label="Close settings"
                onClick={() => { setShowGearMenu(false); setPqKeysExpanded(false); }}
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(0,0,0,0.6)",
                  border: "none",
                  cursor: "pointer",
                }}
              />
              <div
                style={{
                  position: "relative",
                  zIndex: 1,
                  width: 300,
                  maxHeight: "80vh",
                  overflowY: "auto",
                  background: "rgba(12,15,24,0.96)",
                  backdropFilter: "blur(16px)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 14,
                  padding: "20px 18px",
                  fontFamily: SK.font,
                }}
              >
                <p
                  style={{
                    margin: "0 0 12px",
                    fontSize: 9,
                    fontFamily: SK.mono,
                    letterSpacing: "0.1em",
                    color: SIDEBAR_SECTION_LABEL,
                  }}
                >
                  YOUR IDENTITY
                </p>
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 10, color: "#6b7280", fontFamily: "'IBM Plex Mono', monospace", marginBottom: 3, display: "block" }}>
                    Username
                  </label>
                  <div style={{ display: "flex", alignItems: "center", borderRadius: 8, border: `1px solid ${didRegistered ? "rgba(52,211,153,0.3)" : "rgba(255,255,255,0.08)"}`, background: "rgba(0,0,0,0.25)", overflow: "hidden" }}>
                    <span style={{ padding: "8px 0 8px 10px", fontSize: 11, color: "#52525b", fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "nowrap", flexShrink: 0 }}>
                      did:spacekit:user:
                    </span>
                    <input
                      value={myDid.replace(/^did:spacekit:user:/, "")}
                      onChange={(e) => {
                        const name = e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, "");
                        setMyDid(`did:spacekit:user:${name}`);
                        setDidRegistered(false);
                      }}
                      disabled={didRegistered}
                      placeholder="your-name"
                      style={{
                        all: "unset",
                        flex: 1,
                        minWidth: 0,
                        padding: "8px 10px 8px 0",
                        color: didRegistered ? "#34d399" : "#e5e7eb",
                        fontSize: 11,
                        fontFamily: SK.mono,
                        opacity: didRegistered ? 0.8 : 1,
                      }}
                    />
                    {didRegistered && (
                      <span style={{ padding: "0 10px", fontSize: 11, color: "#34d399", flexShrink: 0 }}>✓</span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
                    <p style={{ margin: 0, fontSize: 9, color: "#52525b", fontFamily: "'IBM Plex Mono', monospace" }}>
                      {myDid}
                    </p>
                    {!didRegistered && myDid.replace(/^did:spacekit:user:/, "").length >= 3 && (
                      <button
                        type="button"
                        disabled={chatBusy}
                        onClick={() => void registerDid()}
                        style={{
                          all: "unset",
                          fontSize: 9,
                          fontWeight: 700,
                          color: "#7fd7e6",
                          cursor: chatBusy ? "wait" : "pointer",
                          fontFamily: SK.font,
                          padding: "2px 8px",
                          borderRadius: 4,
                          background: "rgba(34,211,238,0.1)",
                          border: "1px solid rgba(34,211,238,0.2)",
                        }}
                      >
                        {chatBusy ? "…" : "Claim name"}
                      </button>
                    )}
                  </div>
                  {didRegStatus && (
                    <p style={{ margin: "4px 0 0", fontSize: 10, color: didRegistered ? "#34d399" : "#f87171", fontFamily: "'DM Sans', sans-serif" }}>
                      {didRegStatus}
                    </p>
                  )}
                </div>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Display name"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    marginBottom: 8,
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(0,0,0,0.25)",
                    color: "#e5e7eb",
                    fontSize: 12,
                    fontFamily: SK.font,
                  }}
                />
                <button
                  type="button"
                  onClick={() => setPqKeysExpanded((v) => !v)}
                  style={{
                    all: "unset",
                    display: "block",
                    width: "100%",
                    boxSizing: "border-box",
                    marginBottom: pqKeysExpanded ? 6 : 8,
                    padding: "8px 10px",
                    borderRadius: 8,
                    textAlign: "left",
                    cursor: "pointer",
                    background: "rgba(103,232,249,0.08)",
                    border: "1px solid rgba(103,232,249,0.2)",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#7fd7e6",
                    fontFamily: SK.font,
                  }}
                >
                  Manage PQ Keys {pqKeysExpanded ? "▾" : "▸"}
                </button>
                {pqKeysExpanded && (
                  <HermesPqKeysPanel onKeysChanged={() => void registerKyberPublicKey()} />
                )}
                {/* Wallet Link */}
                {didRegistered && walletConnected && walletAddress && (
                  <button
                    type="button"
                    disabled={chatBusy}
                    onClick={() => void linkWallet()}
                    style={{
                      all: "unset",
                      display: "block",
                      width: "100%",
                      boxSizing: "border-box",
                      marginBottom: 8,
                      padding: "8px 0",
                      borderRadius: 8,
                      textAlign: "center",
                      cursor: chatBusy ? "wait" : "pointer",
                      background: "rgba(168,85,247,0.08)",
                      border: "1px solid rgba(168,85,247,0.25)",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "#a78bfa",
                      fontFamily: SK.font,
                    }}
                  >
                    Link Wallet ({walletAddress.slice(0, 6)}…{walletAddress.slice(-4)})
                  </button>
                )}
                {didRegistered && !walletConnected && (
                  <p style={{ margin: "0 0 8px", fontSize: 10, color: "#6b7280", textAlign: "center" }}>
                    Connect a wallet to link your ETH address
                  </p>
                )}
                <button
                  type="button"
                  disabled={chatBusy || !apiBase}
                  onClick={async () => {
                    if (!apiBase || !myDid) return;
                    const goingOnline = !publicOptIn;
                    setPublicOptIn(goingOnline);
                    setChatBusy(true);
                    try {
                      await registerPublic(goingOnline);
                      setDirStatus(goingOnline ? "You're discoverable in the directory" : "You're private — you can still receive DMs");
                      void fetchDirectory();
                    } catch {
                      setPublicOptIn(!goingOnline);
                      setDirStatus("Failed to update status");
                    } finally {
                      setChatBusy(false);
                    }
                  }}
                  style={{
                    all: "unset",
                    display: "block",
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "8px 0",
                    borderRadius: 8,
                    textAlign: "center",
                    cursor: apiBase && !chatBusy ? "pointer" : "not-allowed",
                    opacity: apiBase && !chatBusy ? 1 : 0.5,
                    background: publicOptIn
                      ? "rgba(244,63,94,0.06)"
                      : "rgba(52,211,153,0.08)",
                    border: publicOptIn
                      ? "1px solid rgba(244,63,94,0.3)"
                      : "1px solid rgba(52,211,153,0.3)",
                    fontSize: 12,
                    fontWeight: 600,
                    color: publicOptIn ? "#f43f5e" : "#34d399",
                    fontFamily: SK.font,
                    marginBottom: 12,
                  }}
                >
                  {chatBusy ? "Updating…" : publicOptIn ? "Go Private" : "Go Discoverable"}
                </button>
                <p
                  style={{
                    margin: "0 0 8px",
                    fontSize: 9,
                    fontFamily: SK.mono,
                    letterSpacing: "0.1em",
                    color: SIDEBAR_SECTION_LABEL,
                  }}
                >
                  BLOCK LIST
                </p>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  <input
                    value={blockInput}
                    onChange={(e) => setBlockInput(e.target.value)}
                    placeholder="Block DID"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1px solid rgba(255,255,255,0.08)",
                      background: "rgba(0,0,0,0.25)",
                      color: "#e5e7eb",
                      fontSize: 11,
                      fontFamily: SK.mono,
                    }}
                  />
                  <button
                    type="button"
                    onClick={addBlock}
                    style={{
                      all: "unset",
                      padding: "6px 12px",
                      borderRadius: 8,
                      cursor: "pointer",
                      border: "1px solid rgba(255,255,255,0.08)",
                      fontSize: 11,
                      color: "#9ca3af",
                      fontFamily: SK.font,
                    }}
                  >
                    Block
                  </button>
                </div>
                {[...blocked].map((d) => (
                  <div
                    key={d}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 10,
                      color: "#6b7280",
                      marginBottom: 6,
                      fontFamily: SK.mono,
                    }}
                  >
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{d}</span>
                    <button
                      type="button"
                      onClick={() => removeBlock(d)}
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        color: "#7fd7e6",
                        fontSize: 10,
                      }}
                    >
                      Unblock
                    </button>
                  </div>
                ))}
                {import.meta.env.DEV && (
                  <>
                    <p
                      style={{
                        margin: "16px 0 6px",
                        fontSize: 9,
                        fontFamily: SK.mono,
                        letterSpacing: "0.1em",
                        color: SIDEBAR_SECTION_LABEL,
                      }}
                    >
                      MESSAGING URL
                    </p>
                    <input
                      value={messagingUrl}
                      onChange={(e) => setMessagingUrl(e.target.value)}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "6px 8px",
                        borderRadius: 6,
                        border: "1px solid rgba(255,255,255,0.06)",
                        background: "rgba(0,0,0,0.35)",
                        color: "#9ca3af",
                        fontSize: 10,
                        fontFamily: SK.mono,
                        marginBottom: 16,
                      }}
                    />
                  </>
                )}
                <button
                  type="button"
                  onClick={() => { setShowGearMenu(false); setPqKeysExpanded(false); }}
                  style={{
                    all: "unset",
                    display: "block",
                    width: "100%",
                    padding: "8px 0",
                    borderRadius: 8,
                    textAlign: "center",
                    cursor: "pointer",
                    background: "rgba(255,255,255,0.05)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#9ca3af",
                    fontFamily: SK.font,
                  }}
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {/* ── Create Org popup ── */}
          {showCreateOrg && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 100,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <button
                type="button"
                aria-label="Close create org"
                onClick={() => setShowCreateOrg(false)}
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(0,0,0,0.6)",
                  border: "none",
                  cursor: "pointer",
                }}
              />
              <div
                style={{
                  position: "relative",
                  zIndex: 1,
                  width: 300,
                  background: "rgba(12,15,24,0.96)",
                  backdropFilter: "blur(16px)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 14,
                  padding: "20px 18px",
                  fontFamily: SK.font,
                }}
              >
                <p
                  style={{
                    margin: "0 0 12px",
                    fontSize: 14,
                    fontWeight: 700,
                    color: "#f9fafb",
                  }}
                >
                  New Organization
                </p>
                <input
                  value={newOrgName}
                  onChange={(e) => setNewOrgName(e.target.value)}
                  placeholder="Org name"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    marginBottom: 12,
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(0,0,0,0.25)",
                    color: "#e5e7eb",
                    fontSize: 12,
                    fontFamily: SK.font,
                  }}
                />
                <button
                  type="button"
                  disabled={!newOrgName.trim() || chatBusy || !apiBase}
                  onClick={() => { void createOrgViaApi(); }}
                  style={{
                    all: "unset",
                    display: "block",
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "8px 0",
                    borderRadius: 8,
                    textAlign: "center",
                    cursor: newOrgName.trim() ? "pointer" : "not-allowed",
                    opacity: newOrgName.trim() ? 1 : 0.5,
                    background: "#7fd7e6",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#080b0f",
                    fontFamily: SK.font,
                    marginBottom: 8,
                  }}
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNewOrgName("");
                    setShowCreateOrg(false);
                  }}
                  style={{
                    all: "unset",
                    display: "block",
                    width: "100%",
                    padding: "6px 0",
                    borderRadius: 8,
                    textAlign: "center",
                    cursor: "pointer",
                    border: "1px solid rgba(255,255,255,0.08)",
                    fontSize: 11,
                    color: "#9ca3af",
                    fontFamily: SK.font,
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

        </aside>

        <div
          style={{
            flex: "1 1 0%",
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            marginLeft: isNarrow ? 0 : MESSAGING_SIDEBAR_PX,
            background: "transparent",
          }}
        >
          {selectedPeer ? (
            <>
              <div
                style={{
                  padding: isNarrow ? "10px 14px" : "12px 24px",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 10,
                  flexShrink: 0,
                  background: "rgba(255,255,255,0.02)",
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPeer(null);
                    if (isNarrow) setMobileMenuOpen(true);
                  }}
                  style={{
                    all: "unset",
                    flexShrink: 0,
                    cursor: "pointer",
                    padding: "6px 10px",
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#9ca3af",
                    fontFamily: SK.font,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(255,255,255,0.03)",
                  }}
                >
                  ← Chats
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h2
                    style={{
                      margin: 0,
                      fontSize: 15,
                      fontWeight: 700,
                      color: "#f9fafb",
                      letterSpacing: "-0.02em",
                      fontFamily: SK.font,
                    }}
                  >
                    {(() => {
                      if (isActiveGroupChannel && selectedChannelMeta?.name) {
                        return selectedChannelMeta.name;
                      }
                      const dmPeer = selectedPeer
                        ? dmPeerFromThreadUnlessRegistered(selectedPeer, myDid, registeredGroupThreads)
                        : null;
                      return displayNameForDid(dmPeer ?? selectedPeer ?? "", directory);
                    })()}
                  </h2>
                  {activeOrg && (
                    <span style={{ fontSize: 9, color: "#6b7280", fontFamily: "'IBM Plex Mono', monospace" }}>
                      {activeOrg.name}
                    </span>
                  )}
                  <p
                    style={{
                      margin: "2px 0 0",
                      fontSize: 10,
                      color: "#6b7280",
                      fontFamily: SK.mono,
                      wordBreak: "break-all",
                    }}
                  >
                    {(() => {
                      if (isActiveGroupChannel && selectedChannelMeta) {
                        return `Channel · ${selectedChannelMeta.member_dids.length} members`;
                      }
                      const dmPeer = selectedPeer
                        ? dmPeerFromThreadUnlessRegistered(selectedPeer, myDid, registeredGroupThreads)
                        : null;
                      return dmPeer ?? selectedPeer;
                    })()}
                  </p>
                    {e2eReady && !isActiveGroupChannel && (
                      <span style={{ fontSize: 9, color: "#34d399", fontFamily: "'IBM Plex Mono', monospace", marginTop: 2, display: "block" }}>
                        PQ E2E · Kyber-1024
                      </span>
                    )}
                </div>
                {selectedChannelMeta && selectedChannelMeta.member_dids.includes(myDid) && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0, minWidth: isNarrow ? "100%" : 200 }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        value={channelInviteInput}
                        onChange={(e) => setChannelInviteInput(e.target.value)}
                        placeholder="Invite @alice"
                        style={{
                          flex: 1,
                          minWidth: 0,
                          padding: "6px 8px",
                          borderRadius: 6,
                          border: "1px solid rgba(255,255,255,0.08)",
                          background: "rgba(0,0,0,0.35)",
                          color: "#e5e7eb",
                          fontSize: 11,
                          fontFamily: SK.font,
                        }}
                      />
                      <button
                        type="button"
                        disabled={!channelInviteInput.trim() || chatBusy}
                        onClick={() => void inviteMemberToChannel(selectedChannelMeta.id, channelInviteInput, selectedChannelMeta.name)}
                        style={{
                          all: "unset",
                          padding: "6px 10px",
                          borderRadius: 6,
                          fontSize: 10,
                          fontWeight: 600,
                          cursor: channelInviteInput.trim() && !chatBusy ? "pointer" : "not-allowed",
                          opacity: channelInviteInput.trim() && !chatBusy ? 1 : 0.5,
                          border: "1px solid rgba(103,232,249,0.2)",
                          background: "rgba(103,232,249,0.06)",
                          color: "#7fd7e6",
                          fontFamily: SK.font,
                        }}
                      >
                        Invite
                      </button>
                    </div>
                    {selectedChannelMeta.creator_did === myDid && (
                      <button
                        type="button"
                        disabled={chatBusy}
                        onClick={() => void deleteChannelViaApi(selectedChannelMeta.id, selectedChannelMeta.name, selectedPeer ?? undefined)}
                        style={{
                          all: "unset",
                          padding: "5px 10px",
                          borderRadius: 6,
                          fontSize: 10,
                          fontWeight: 600,
                          cursor: chatBusy ? "not-allowed" : "pointer",
                          opacity: chatBusy ? 0.5 : 1,
                          border: "1px solid rgba(244,63,94,0.25)",
                          background: "rgba(244,63,94,0.08)",
                          color: "#f87171",
                          fontFamily: SK.font,
                          textAlign: "center",
                        }}
                      >
                        Delete channel
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div
                ref={messagesScrollRef}
                className={`messaging-messages-scroll${isActiveGroupChannel ? " messaging-messages-scroll--channel" : ""}`}
                style={{
                  padding: isNarrow ? "8px 0" : "12px 0",
                }}
              >
                {currentMessages.map((msg) => (
                  <DmBubble
                    key={msg.id}
                    role={msg.role}
                    content={msg.content}
                    peerDid={myDid}
                    senderDid={msg.role === "peer" ? msg.senderDid : myDid}
                    senderLabel={
                      msg.role === "user"
                        ? (displayName || myDid.split(":").pop() || "You")
                        : displayNameForDid(msg.senderDid ?? "", directory)
                    }
                    createdAt={msg.createdAt}
                    layout={isActiveGroupChannel ? "channel" : "dm"}
                    narrow={isNarrow}
                    messageId={msg.id}
                    storageBase={storageBase}
                    messagingApiBase={messagingApiBase}
                    myDid={myDid}
                    onDeleteMessage={msg.role === "user" ? deleteMessage : undefined}
                    onMediaClick={(tag, url, name) => setLightbox({ tag, url, name })}
                  />
                ))}
              </div>

              <div className="slack-composer-wrap">
                {chatStatus ? (
                  <p className="slack-composer-status">{chatStatus}</p>
                ) : null}
                <div className="slack-composer">
                  <button
                    type="button"
                    className="slack-composer-attach"
                    title="Attach file"
                    onClick={() => {
                      const input = document.createElement("input");
                      input.type = "file";
                      input.accept = "image/*,video/*,.pdf,.md,.markdown,.txt,.json,.csv";
                      input.onchange = async () => {
                        const file = input.files?.[0];
                        if (!file || !storageBase) {
                          setChatStatus(storageBase ? "No file selected" : "Storage not configured");
                          return;
                        }
                        setChatBusy(true);
                        setChatStatus("Uploading…");
                        try {
                          const attachment = await uploadChatAttachment(file, myDid, storageBase);
                          setChatMessage((prev) => `${prev}${attachment}`.trim());
                          setChatStatus("Attached — press Send");
                        } catch (e) {
                          setChatStatus(formatUserFacingError(e, "Upload failed"));
                        } finally {
                          setChatBusy(false);
                        }
                      };
                      input.click();
                    }}
                  >
                    +
                  </button>
                  <textarea
                    className="slack-composer-input"
                    value={chatMessage}
                    onChange={(e) => setChatMessage(e.target.value)}
                    onKeyDown={onComposerKeyDown}
                    placeholder={
                      isActiveGroupChannel && selectedChannelMeta
                        ? `Message #${selectedChannelMeta.name}`
                        : `Message ${displayNameForDid(selectedPeer, directory)}…`
                    }
                    rows={2}
                  />
                  <button
                    type="button"
                    className="slack-composer-send"
                    disabled={chatBusy}
                    onClick={() => void sendChat()}
                  >
                    {chatBusy ? "…" : "Send"}
                  </button>
                </div>
                <p className="slack-composer-hint">
                  Enter to send · Shift+Enter for newline
                </p>
              </div>
            </>
          ) : (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                minHeight: 0,
                padding: 40,
                textAlign: "center",
              }}
            >
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 16,
                  background: "rgba(103,232,249,0.08)",
                  border: "1px solid rgba(103,232,249,0.2)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 28,
                  marginBottom: 20,
                }}
              >
                ◆
              </div>
              <h3
                style={{
                  margin: "0 0 8px",
                  fontSize: 18,
                  fontWeight: 700,
                  color: "#f1f5f9",
                  fontFamily: SK.font,
                }}
              >
                Select a conversation
              </h3>
              <p
                style={{
                  margin: "0 0 20px",
                  fontSize: 13,
                  color: "#94a3b8",
                  maxWidth: 320,
                  lineHeight: 1.5,
                }}
              >
                Choose a peer from the sidebar or start a new conversation to begin messaging with post-quantum encryption.
              </p>
              <button
                type="button"
                onClick={() => {
                  setShowNewChat(true);
                  if (isNarrow) setMobileMenuOpen(true);
                }}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  padding: "10px 20px",
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#080b0f",
                  background: "#7fd7e6",
                  fontFamily: SK.font,
                  marginBottom: 12,
                }}
              >
                New Message
              </button>
              {totalUnread > 0 && (
                <div
                  style={{
                    padding: "8px 16px",
                    borderRadius: 8,
                    background: "rgba(103,232,249,0.08)",
                    border: "1px solid rgba(103,232,249,0.2)",
                    fontSize: 12,
                    color: "#7fd7e6",
                  }}
                >
                  {totalUnread} unread message{totalUnread === 1 ? "" : "s"}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {lightbox && (
        <MediaLightbox
          tag={lightbox.tag}
          url={lightbox.url}
          name={lightbox.name}
          storageBase={storageBase}
          messagingApiBase={messagingApiBase}
          myDid={myDid}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
};

export default HermesApp;
