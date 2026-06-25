import { getStore } from "@netlify/blobs";

const key = "share-log";
const maxEntries = 200;

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

export default async (request) => {
  const store = getStore("coupang-message-app");

  if (request.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });

  if (request.method === "GET") {
    const entries = await store.get(key, { type: "json", consistency: "strong" });
    return json({ entries: Array.isArray(entries) ? entries : [] });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => null);
    const message = String(body?.message || "").slice(0, 5000);

    if (!message.trim()) {
      return json({ error: "Message is required" }, { status: 400 });
    }

    const entries = await store.get(key, { type: "json", consistency: "strong" });
    const nextEntry = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      mode: String(body?.mode || "").slice(0, 30),
      message
    };

    const nextEntries = [nextEntry, ...(Array.isArray(entries) ? entries : [])].slice(0, maxEntries);
    await store.setJSON(key, nextEntries);

    return json({ ok: true, entry: nextEntry });
  }

  return json({ error: "Method not allowed" }, { status: 405 });
};

export const config = {
  path: "/api/share-log"
};
