import { getStore } from "@netlify/blobs";

const key = "edit-session";
const ttlMs = 6 * 1000;

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

async function readBody(request) {
  const text = await request.text().catch(() => "");
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function isExpired(record, now) {
  return !record?.clientId || !record?.expiresAt || new Date(record.expiresAt).getTime() <= now;
}

function publicSession(record, now) {
  if (isExpired(record, now)) {
    return { locked: false, owner: false, expiresAt: null, ttlMs };
  }

  return {
    locked: true,
    owner: false,
    expiresAt: record.expiresAt,
    ttlMs: Math.max(new Date(record.expiresAt).getTime() - now, 0)
  };
}

export default async (request) => {
  const store = getStore("coupang-message-app");
  const now = Date.now();

  if (request.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });

  if (request.method === "GET") {
    const record = await store.get(key, { type: "json", consistency: "strong" });
    return json(publicSession(record, now));
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await readBody(request);
  const clientId = String(body.clientId || "").slice(0, 120);
  const action = String(body.action || "acquire");

  if (!clientId) {
    return json({ error: "clientId is required" }, { status: 400 });
  }

  const record = await store.get(key, { type: "json", consistency: "strong" });
  const ownsSession = record?.clientId === clientId;

  if (action === "release") {
    if (ownsSession) await store.delete(key);
    return json({ ok: true, owner: false, locked: false, expiresAt: null, ttlMs });
  }

  if (!isExpired(record, now) && !ownsSession) {
    return json({
      owner: false,
      locked: true,
      expiresAt: record.expiresAt,
      ttlMs: Math.max(new Date(record.expiresAt).getTime() - now, 0)
    });
  }

  const nextRecord = {
    clientId,
    startedAt: ownsSession && record.startedAt ? record.startedAt : new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString()
  };

  await store.setJSON(key, nextRecord);

  return json({
    owner: true,
    locked: false,
    expiresAt: nextRecord.expiresAt,
    ttlMs
  });
};

export const config = {
  path: "/api/session"
};
