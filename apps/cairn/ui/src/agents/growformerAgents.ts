/**
 * Growformer agents: browser WASM (packaged .spkg) with dev CLI proxy fallback.
 */

import {
  inferLinksViaWasm,
  inferSummaryViaWasm,
  inferTagsViaWasm,
  isWasmInferenceAvailable,
} from "./wasmRuntime";
import {
  isSummaryPlausible,
  isTagsPlausible,
  prepareSummaryPrompt,
} from "./noteText";

type LinkHit = { id: string; title: string; score: number };

let wasmChecked = false;
let wasmAvailable = false;

async function preferWasm(): Promise<boolean> {
  if (wasmChecked) return wasmAvailable;
  wasmAvailable = await isWasmInferenceAvailable();
  wasmChecked = true;
  return wasmAvailable;
}

/** Dev-only Vite proxy when packaged brains are unavailable. */
function agentApiUrl(agent: "tagger" | "summarizer" | "linker"): string {
  const path = `/__spacekit-dev/agents/${agent}`;
  const parent = window.__SPACEKIT_EMBED__?.parentOrigin?.replace(/\/$/, "");
  return parent ? `${parent}${path}` : path;
}

async function postAgent<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function inferAutoTagsViaApi(content: string): Promise<string[] | null> {
  const trimmed = content.trim();
  if (!trimmed) return [];

  if (await preferWasm()) {
    const tags = await inferTagsViaWasm(trimmed);
    if (tags && isTagsPlausible(trimmed, tags)) return tags;
  }

  const data = await postAgent<{ tags?: unknown }>(agentApiUrl("tagger"), { content: trimmed });
  if (!data || !Array.isArray(data.tags)) return null;
  const tags = data.tags.filter((t): t is string => typeof t === "string" && t.length > 0);
  if (!isTagsPlausible(trimmed, tags)) return null;
  return tags;
}

export async function inferSummaryViaApi(content: string): Promise<string | null> {
  const trimmed = content.trim();
  if (!trimmed) return "";

  if (await preferWasm()) {
    const summary = await inferSummaryViaWasm(trimmed);
    if (summary && isSummaryPlausible(trimmed, summary)) return summary;
  }

  const data = await postAgent<{ summary?: unknown }>(agentApiUrl("summarizer"), {
    content: trimmed,
    prompt: prepareSummaryPrompt(trimmed),
  });
  if (!data || typeof data.summary !== "string" || !data.summary.trim()) return null;
  const summary = data.summary.trim();
  if (!isSummaryPlausible(trimmed, summary)) return null;
  return summary;
}

export async function inferLinksViaApi(
  content: string,
  noteId: string,
  corpus: { id: string; title: string; content: string }[]
): Promise<LinkHit[] | null> {
  const trimmed = content.trim();
  if (!trimmed || corpus.length === 0) return [];

  if (await preferWasm()) {
    const related = await inferLinksViaWasm(trimmed, noteId, corpus);
    if (related) return related;
  }

  const data = await postAgent<{ related?: unknown }>(agentApiUrl("linker"), {
    content: trimmed,
    noteId,
    corpus,
  });
  if (!data || !Array.isArray(data.related)) return null;
  return data.related.filter(
    (r): r is LinkHit =>
      !!r &&
      typeof r === "object" &&
      typeof (r as LinkHit).id === "string" &&
      typeof (r as LinkHit).title === "string" &&
      typeof (r as LinkHit).score === "number"
  );
}

export { warmWasmAgents } from "./wasmRuntime";
