/**
 * In-browser growformer inference — all assets resolved from packaged .spkg refs
 * (__SPACEKIT_EMBED__.assetUrls). Nothing is bundled into the UI build.
 */
import { prepareSummaryPrompt } from "./noteText";

export type AgentKind = "tagger" | "summarizer" | "linker";

type AgentsManifest = {
  version: number;
  growformer: {
    js: string;
    wasm: string;
  };
  contract_wasm?: string;
  agents: Record<
    AgentKind,
    {
      project: string;
      brain: string;
    }
  >;
};

type CorpusNote = { id: string; title: string; content: string };

type GrowformerModule = {
  default: (moduleOrPath?: string | { module_or_path: string }) => Promise<unknown>;
  growformer_init: () => void;
  growformer_load_brain: (data: Uint8Array) => void;
  growformer_ready: () => boolean;
  growformer_generation: (text: string) => unknown;
  growformer_reset_conversation: () => void;
  growformer_load_inference_toml: (toml: string) => void;
  growformer_load_topic_graph?: (base: string, overlay?: string) => void;
  growformer_clear_topic_graph?: () => void;
};

declare global {
  interface Window {
    __SPACEKIT_EMBED__?: {
      parentOrigin?: string;
      assetUrls?: Record<string, string>;
    };
    spacekit?: {
      http?: {
        fetch: (url: string, init?: RequestInit) => Promise<Response>;
      };
    };
  }
}

const MANIFEST_PATH = "agents/manifest.json";
const INFERENCE_SUFFIX = "data/inference.toml";
const TOPIC_GRAPH_SUFFIX = "data/knowledge_graph.toml";

let gf: GrowformerModule | null = null;
let initPromise: Promise<boolean> | null = null;
let manifest: AgentsManifest | null = null;
let loadedAgent: AgentKind | null = null;
let lastInferenceToml = "";
let lastTopicGraph = "";

function normalizeAssetPath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\//, "");
}

/** Resolve a packaged content_ref path to its deploy-time URL (blob or storage stream). */
function resolvePackagedAsset(path: string): string | null {
  const norm = normalizeAssetPath(path);
  const urls = window.__SPACEKIT_EMBED__?.assetUrls;
  if (!urls) return null;
  if (urls[norm]) return urls[norm];
  for (const [key, url] of Object.entries(urls)) {
    if (key === norm || key.endsWith(`/${norm}`)) return url;
  }
  return null;
}

function hasPackagedAsset(path: string): boolean {
  return resolvePackagedAsset(path) !== null;
}

async function fetchAsset(url: string): Promise<Response> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) return res;
  } catch {
    /* fall through to parent HTTP bridge */
  }
  const bridge = window.spacekit?.http?.fetch;
  if (bridge) {
    const res = await bridge(url, { cache: "no-store" });
    if (res.ok) return res;
    throw new Error(`asset fetch failed (${res.status}): ${url}`);
  }
  throw new Error(`asset fetch failed: ${url}`);
}

async function fetchPackagedText(path: string): Promise<string> {
  const url = resolvePackagedAsset(path);
  if (!url) throw new Error(`packaged asset not in spkg refs: ${path}`);
  const res = await fetchAsset(url);
  return res.text();
}

async function fetchPackagedBytes(path: string): Promise<Uint8Array> {
  const url = resolvePackagedAsset(path);
  if (!url) throw new Error(`packaged asset not in spkg refs: ${path}`);
  const res = await fetchAsset(url);
  return new Uint8Array(await res.arrayBuffer());
}

function agentDir(agentPath: string): string {
  const norm = normalizeAssetPath(agentPath);
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(0, idx) : norm;
}

async function loadManifest(): Promise<AgentsManifest | null> {
  if (manifest) return manifest;
  if (!hasPackagedAsset(MANIFEST_PATH)) return null;
  try {
    const text = await fetchPackagedText(MANIFEST_PATH);
    manifest = JSON.parse(text) as AgentsManifest;
    return manifest;
  } catch {
    return null;
  }
}

function manifestReady(mf: AgentsManifest): boolean {
  return (
    Boolean(mf.growformer?.js && mf.growformer?.wasm) &&
    hasPackagedAsset(mf.growformer.js) &&
    hasPackagedAsset(mf.growformer.wasm)
  );
}

async function ensureGrowformerHost(): Promise<boolean> {
  if (gf?.growformer_ready()) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const mf = await loadManifest();
      if (!mf || !manifestReady(mf)) return false;

      const jsUrl = resolvePackagedAsset(mf.growformer.js);
      const wasmUrl = resolvePackagedAsset(mf.growformer.wasm);
      if (!jsUrl || !wasmUrl) return false;

      const mod = (await import(/* @vite-ignore */ jsUrl)) as GrowformerModule;
      await mod.default(wasmUrl);
      mod.growformer_init();
      gf = mod;
      return gf.growformer_ready();
    } catch (err) {
      console.warn("[cairn] growformer WASM init failed", err);
      gf = null;
      return false;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

function applyInferenceToml(toml: string): void {
  if (!gf) return;
  const trimmed = toml.trim();
  if (!trimmed || lastInferenceToml === trimmed) return;
  gf.growformer_load_inference_toml(trimmed);
  lastInferenceToml = trimmed;
}

function applyTopicGraph(toml: string): void {
  if (!gf?.growformer_load_topic_graph) return;
  const trimmed = toml.trim();
  if (!trimmed || lastTopicGraph === trimmed) return;
  gf.growformer_clear_topic_graph?.();
  gf.growformer_load_topic_graph(trimmed);
  lastTopicGraph = trimmed;
}

async function activateAgent(kind: AgentKind): Promise<boolean> {
  const mf = await loadManifest();
  if (!mf?.agents?.[kind]) return false;

  const ready = await ensureGrowformerHost();
  if (!ready || !gf) return false;

  if (loadedAgent === kind && gf.growformer_ready()) return true;

  const cfg = mf.agents[kind];
  const dir = agentDir(cfg.brain);

  const [brainBytes, inferenceToml, topicGraph] = await Promise.all([
    fetchPackagedBytes(cfg.brain),
    fetchPackagedText(`${dir}/${INFERENCE_SUFFIX}`),
    fetchPackagedText(`${dir}/${TOPIC_GRAPH_SUFFIX}`),
  ]);

  gf.growformer_load_brain(brainBytes);
  applyInferenceToml(inferenceToml);
  applyTopicGraph(topicGraph);
  loadedAgent = kind;
  return gf.growformer_ready();
}

function growformerGeneration(prompt: string): string {
  if (!gf?.growformer_ready()) throw new Error("growformer not ready");
  gf.growformer_reset_conversation();
  try {
    const raw = gf.growformer_generation(prompt);
    return typeof raw === "string" ? raw : JSON.stringify(raw);
  } finally {
    gf.growformer_reset_conversation();
  }
}

function parseGenerationText(json: string): string {
  const parsed = JSON.parse(json) as { text?: unknown };
  if (typeof parsed.text !== "string" || !parsed.text.trim()) {
    throw new Error("growformer response missing text");
  }
  return parsed.text.trim();
}

function parseJsonArrayText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) {
    throw new Error("expected JSON array in generation text");
  }
  const arr = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(arr)) throw new Error("expected JSON array in generation text");
  return arr.filter((t): t is string => typeof t === "string" && t.length > 0);
}

function buildCorpusBlock(corpus: CorpusNote[]): string {
  const lines = ["Available notes:"];
  for (const note of corpus) {
    const snippet = note.content.replace(/\s+/g, " ").trim().slice(0, 160);
    lines.push(`- ${note.title}: ${snippet}`);
  }
  return lines.join("\n");
}

function buildPrompt(kind: AgentKind, content: string, corpus?: CorpusNote[]): string {
  const trimmed = content.trim();
  if (kind === "tagger") return trimmed;
  if (kind === "summarizer") {
    return prepareSummaryPrompt(trimmed) || (trimmed ? `summarize: ${trimmed}` : trimmed);
  }
  const block = buildCorpusBlock(corpus ?? []);
  return trimmed ? `suggest links for:\n${trimmed}\n\n${block}` : block;
}

function mapLinkerTitles(
  titles: string[],
  corpus: CorpusNote[],
  noteId?: string
): { id: string; title: string; score: number }[] {
  const byTitle = new Map(corpus.map((n) => [n.title.toLowerCase(), n]));
  const out: { id: string; title: string; score: number }[] = [];
  titles.forEach((title, i) => {
    const note = byTitle.get(title.toLowerCase());
    if (!note || note.id === noteId) return;
    out.push({ id: note.id, title: note.title, score: Math.max(1, titles.length - i) });
  });
  return out;
}

export async function isWasmInferenceAvailable(): Promise<boolean> {
  const mf = await loadManifest();
  return mf !== null && manifestReady(mf);
}

/** Preload growformer WASM + tagger brain to hide first-infer latency. */
export async function warmWasmAgents(): Promise<void> {
  try {
    if (!(await isWasmInferenceAvailable())) return;
    await activateAgent("tagger");
  } catch (err) {
    console.warn("[cairn] wasm warm-up skipped", err);
  }
}

export async function inferTagsViaWasm(content: string): Promise<string[] | null> {
  try {
    if (!(await activateAgent("tagger"))) return null;
    const json = growformerGeneration(buildPrompt("tagger", content));
    return parseJsonArrayText(parseGenerationText(json));
  } catch (err) {
    console.warn("[cairn] wasm tagger failed", err);
    return null;
  }
}

export async function inferSummaryViaWasm(content: string): Promise<string | null> {
  try {
    if (!(await activateAgent("summarizer"))) return null;
    const json = growformerGeneration(buildPrompt("summarizer", content));
    return parseGenerationText(json);
  } catch (err) {
    console.warn("[cairn] wasm summarizer failed", err);
    return null;
  }
}

export async function inferLinksViaWasm(
  content: string,
  noteId: string,
  corpus: CorpusNote[]
): Promise<{ id: string; title: string; score: number }[] | null> {
  try {
    if (!content.trim() || corpus.length === 0) return [];
    if (!(await activateAgent("linker"))) return null;
    const json = growformerGeneration(buildPrompt("linker", content, corpus));
    const titles = parseJsonArrayText(parseGenerationText(json));
    return mapLinkerTitles(titles, corpus, noteId);
  } catch (err) {
    console.warn("[cairn] wasm linker failed", err);
    return null;
  }
}
