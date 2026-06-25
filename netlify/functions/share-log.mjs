import { getStore } from "@netlify/blobs";

const key = "share-log";
const maxEntries = 200;
const retentionDays = 7;
const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...jsonHeaders, ...(init.headers || {}) }
  });
}

function pruneEntries(entries, now = Date.now()) {
  if (!Array.isArray(entries)) return [];
  const cutoff = now - retentionMs;

  return entries
    .filter((entry) => {
      const createdAt = new Date(entry?.createdAt || 0).getTime();
      return Number.isFinite(createdAt) && createdAt >= cutoff;
    })
    .slice(0, maxEntries);
}

export default async (request) => {
  const store = getStore("coupang-message-app");

  if (request.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });

  if (request.method === "GET") {
    const entries = await store.get(key, { type: "json", consistency: "strong" });
    const prunedEntries = pruneEntries(entries);
    if (Array.isArray(entries) && prunedEntries.length !== entries.length) {
      await store.setJSON(key, prunedEntries);
    }

    return json({ entries: prunedEntries, retentionDays });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => null);
    const message = String(body?.message || "").slice(0, 5000);

    if (!message.trim()) {
      return json({ error: "Message is required" }, { status: 400 });
    }

    const entries = pruneEntries(await store.get(key, { type: "json", consistency: "strong" }));
    const nextEntry = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      mode: String(body?.mode || "").slice(0, 30),
      message
    };

    const nextEntries = [nextEntry, ...(Array.isArray(entries) ? entries : [])].slice(0, maxEntries);
    await store.setJSON(key, nextEntries);

    return json({ ok: true, entry: nextEntry, retentionDays });
  }

  return json({ error: "Method not allowed" }, { status: 405 });
};

export const config = {
  path: "/api/share-log"
};
