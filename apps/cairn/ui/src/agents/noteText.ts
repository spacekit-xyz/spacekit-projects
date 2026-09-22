/** Shared note normalization + summary quality checks for growformer agents. */

const STOPWORDS = new Set(
  "the of and a to in is you that it he was for on are with as i his they be at one have this from or had by but some what there we can out other were all your when up use how said an each she which do their time if will way about many then them write would like so these her long make thing see him two has look more day could go come did number sound no most people my over know water than call first who may down side been now find any new work part take get place made live where after back little only round man year came show every good me give our under name very through just form sentence great think say help low line differ turn cause much mean before move right boy old too same tell does set three want air well also play small end put home read hand port large spell add even land here must big high such follow act why ask men change went light kind off need house picture try us again animal point mother world near build self earth father".split(
    " "
  )
);

const MAX_SUMMARY_CHARS = 320;
const MAX_BRAIN_PROMPT_CHARS = 1400;

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((t) => !STOPWORDS.has(t));
}

function truncateSummary(text: string, max = MAX_SUMMARY_CHARS): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function listLine(line: string): string {
  return line.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "").trim();
}

function nonEmptyLines(content: string): string[] {
  return content.split(/\n+/).map((l) => l.trim()).filter(Boolean);
}

/** True when lines look like bullets/numbered list items, not prose paragraphs. */
export function looksLikeList(content: string): boolean {
  const lines = nonEmptyLines(content);
  if (lines.length < 2) return false;

  const marked = lines.filter((l) => /^[-*•]\s+/.test(l) || /^\d+\.\s+/.test(l)).length;
  if (marked >= 2 || marked / lines.length >= 0.5) return true;

  const avgLen = lines.reduce((n, l) => n + l.length, 0) / lines.length;
  // Short line stacks (task lists) without explicit markers.
  return lines.length >= 3 && avgLen < 100 && lines.every((l) => l.length < 160);
}

/** List items only — does not split prose paragraphs on single newlines. */
export function noteToListUnits(content: string): string[] {
  return nonEmptyLines(content).map(listLine).filter(Boolean);
}

function proseParagraphs(content: string): string[] {
  const blocks = content
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (blocks.length > 0) return blocks;
  const one = content.replace(/\s+/g, " ").trim();
  return one ? [one] : [];
}

/** Split on sentence boundaries without lookbehind (Safari / Tauri WKWebView). */
function proseSentences(content: string): string[] {
  const flat = content.replace(/\s+/g, " ").trim();
  if (!flat) return [];
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i];
    if ((ch === "." || ch === "!" || ch === "?") && (i + 1 === flat.length || /\s/.test(flat[i + 1]!))) {
      const chunk = flat.slice(start, i + 1).trim();
      if (chunk) parts.push(chunk);
      while (i + 1 < flat.length && /\s/.test(flat[i + 1]!)) i++;
      start = i + 1;
    }
  }
  const tail = flat.slice(start).trim();
  if (tail) parts.push(tail);
  return parts.length > 0 ? parts : [flat];
}

function proseLeadChunk(content: string, max = MAX_BRAIN_PROMPT_CHARS): string {
  const paras = proseParagraphs(content);
  let out = "";
  for (const p of paras) {
    const next = out ? `${out}\n\n${p}` : p;
    if (next.length > max) break;
    out = next;
  }
  if (out) return out;
  return truncateSummary(content.replace(/\s+/g, " "), max);
}

/** Prompt for lookup brain — lists as numbered items; long prose as opening chunk only. */
export function prepareSummaryPrompt(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return trimmed;

  if (looksLikeList(trimmed)) {
    const units = noteToListUnits(trimmed);
    if (units.length <= 1) return `summarize: ${units[0] ?? trimmed}`;
    return `summarize this note (${units.length} items):\n${units.map((u, i) => `${i + 1}. ${u}`).join("\n")}`;
  }

  const chunk = proseLeadChunk(trimmed);
  return `summarize: ${chunk}`;
}

/** Reject unrelated lattice neighbors and regurgitated input masquerading as a summary. */
export function isSummaryPlausible(input: string, summary: string): boolean {
  const sum = summary.trim();
  if (!sum) return false;
  if (sum.length > MAX_SUMMARY_CHARS * 1.5) return false;

  const normIn = input.replace(/\s+/g, " ").toLowerCase();
  const normSum = sum.replace(/\s+/g, " ").toLowerCase();

  if (normIn.includes(normSum) && normSum.length > Math.min(normIn.length * 0.35, 500)) {
    return false;
  }

  const inTok = new Set(tokenize(input));
  const sumTok = tokenize(sum);
  if (sumTok.length === 0) return true;

  let overlap = 0;
  for (const t of sumTok) if (inTok.has(t)) overlap++;
  const ratio = overlap / sumTok.length;

  if (looksLikeList(input)) {
    const units = noteToListUnits(input);
    if (units.length >= 3 && ratio < 0.18) return false;
  } else if (input.length > 400 && ratio < 0.22) {
    return false;
  }

  return true;
}

/** Reject OOD lattice neighbors whose tags don't relate to the note vocabulary. */
export function isTagsPlausible(input: string, tags: string[]): boolean {
  if (tags.length === 0) return false;

  const normIn = input.toLowerCase();
  const inTok = new Set(tokenize(input));
  const tagTok = tags.flatMap((t) => tokenize(t));
  if (tagTok.length === 0) return false;

  let overlap = 0;
  for (const t of tagTok) if (inTok.has(t)) overlap++;
  const tokenRatio = overlap / tagTok.length;

  const literalHits = tags.filter((t) => normIn.includes(t.toLowerCase())).length;

  // Fiction / OOD notes: require most tag tokens to appear in the note, or literal tag hits.
  if (tokenRatio < 0.34 && literalHits < 2) return false;

  return true;
}

function extractiveListSummary(content: string): string {
  const units = noteToListUnits(content);
  if (units.length === 0) return "";
  if (units.length === 1) return truncateSummary(units[0]);
  const lead = units.slice(0, 2).join("; ");
  if (units.length === 2) return truncateSummary(lead);
  const peek = units.slice(2, Math.min(4, units.length)).join("; ");
  return truncateSummary(
    `${lead}. Covers ${units.length} items, including ${peek}${units.length > 4 ? "…" : ""}.`
  );
}

/** Pick 1–2 high-salience sentences from prose (opening + best-scored). */
function extractiveProseSummary(content: string): string {
  const sentences = proseSentences(content);
  if (sentences.length === 0) return "";
  if (sentences.length === 1) return truncateSummary(sentences[0]);

  const freq = new Map<string, number>();
  for (const t of tokenize(content)) freq.set(t, (freq.get(t) || 0) + 1);

  const scored = sentences.map((s, i) => ({
    s,
    score:
      tokenize(s).reduce((sum, t) => sum + (freq.get(t) || 0), 0) / Math.max(1, tokenize(s).length) +
      (i === 0 ? 0.35 : 0),
  }));

  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .sort((a, b) => sentences.indexOf(a.s) - sentences.indexOf(b.s))
    .map((x) => x.s);

  return truncateSummary(top.join(" "));
}

/** Fallback when growformer is unavailable or low-confidence. */
export function extractiveNoteSummary(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  return looksLikeList(trimmed) ? extractiveListSummary(trimmed) : extractiveProseSummary(trimmed);
}
