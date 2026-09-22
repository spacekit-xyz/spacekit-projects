/** Turn raw fetch / HTTP failures into copy suitable for composer status lines. */
export function formatUserFacingError(
  error: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  const lower = msg.toLowerCase();

  if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid or expired session") ||
    lower.includes("bearer session required")
  ) {
    return "Your session expired. Sign in again, then retry.";
  }

  if (
    msg === "Failed to fetch" ||
    lower.includes("networkerror") ||
    lower.includes("network error") ||
    lower.includes("load failed")
  ) {
    return "Could not reach messaging. Check your connection, or sign in again if your session expired.";
  }

  if (lower.startsWith("gateway error:")) {
    const statusMatch = msg.match(/gateway error:\s*(\d+)/i);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    if (status === 401) return "Your session expired. Sign in again, then retry.";
    if (status >= 500) return `Messaging service error (${status}). Try again in a moment.`;
    if (status >= 400) {
      const detail = msg.split("—").slice(1).join("—").trim();
      if (detail) return detail.length > 140 ? `${detail.slice(0, 140)}…` : detail;
      return `Could not send (${status}). Try again.`;
    }
  }

  if (!msg.trim()) return fallback;
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg;
}
