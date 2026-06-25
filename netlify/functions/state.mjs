import { getStore } from "@netlify/blobs";

const key = "shared-state";

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

function sanitizeState(value) {
  if (!value || typeof value !== "object") return null;

  return {
    mode: value.mode,
    title: value.title,
    mixed: value.mixed,
    mixedLines: value.mixedLines,
    currentMixedLine: value.currentMixedLine,
    places: value.places,
    feeders: value.feeders,
    memo: value.memo
  };
}

export default async (request) => {
  const store = getStore("coupang-message-app");

  if (request.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });

  if (request.method === "GET") {
    const saved = await store.get(key, { type: "json", consistency: "strong" });
    return json(saved || { state: null, updatedAt: null });
  }

  if (request.method === "PUT" || request.method === "POST") {
    const body = await request.json().catch(() => null);
    const state = sanitizeState(body?.state || body);

    if (!state) {
      return json({ error: "Invalid state" }, { status: 400 });
    }

    const record = {
      state,
      updatedAt: new Date().toISOString()
    };

    await store.setJSON(key, record);
    return json(record);
  }

  return json({ error: "Method not allowed" }, { status: 405 });
};

export const config = {
  path: "/api/state"
};
