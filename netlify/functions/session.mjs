import { getStore } from "@netlify/blobs";

const key = "edit-session";
const priorityKey = "worker-priority";
const workerNamesKey = "worker-names";
const ttlMs = 6 * 1000;
const adminPassword = "1104";
const defaultPriorityNames = ["선웅"];

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

function sanitizeWorkerName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 12);
}

function normalizePriorityNames(value) {
  const rawNames = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,>]+/);

  return [...new Set(rawNames.map(sanitizeWorkerName).filter(Boolean))].slice(0, 20);
}

function normalizeWorkerNames(value) {
  const rawNames = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,>]+/);

  return [...new Set(rawNames.map(sanitizeWorkerName).filter(Boolean))].slice(0, 100);
}

async function readWorkerNames(store) {
  const saved = await store.get(workerNamesKey, { type: "json", consistency: "strong" });
  const priorityNames = await readPriorityNames(store);
  return normalizeWorkerNames([...(saved?.workerNames || []), ...defaultPriorityNames, ...priorityNames]);
}

async function registerWorkerName(store, name) {
  const worker = sanitizeWorkerName(name);
  if (!worker) return;

  const workerNames = normalizeWorkerNames([...(await readWorkerNames(store)), worker]);
  await store.setJSON(workerNamesKey, {
    workerNames,
    updatedAt: new Date().toISOString()
  });
}

async function readPriorityNames(store) {
  const saved = await store.get(priorityKey, { type: "json", consistency: "strong" });
  if (saved && Array.isArray(saved.priorityNames)) return normalizePriorityNames(saved.priorityNames);
  return defaultPriorityNames;
}

async function savePriorityNames(store, names) {
  const priorityNames = normalizePriorityNames(names);
  await store.setJSON(priorityKey, {
    priorityNames,
    updatedAt: new Date().toISOString()
  });
  return priorityNames;
}

function priorityRank(name, priorityNames) {
  const normalized = sanitizeWorkerName(name);
  const index = priorityNames.findIndex((item) => item === normalized);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function publicSession(record, now) {
  if (isExpired(record, now)) {
    return { locked: false, owner: false, workerName: "", expiresAt: null, ttlMs };
  }

  return {
    locked: true,
    owner: false,
    workerName: sanitizeWorkerName(record.workerName),
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
  const workerName = sanitizeWorkerName(body.workerName);
  const action = String(body.action || "acquire");

  if (!clientId) {
    return json({ error: "clientId is required" }, { status: 400 });
  }

  await registerWorkerName(store, workerName);

  if (action === "admin-get-priority" || action === "admin-save-priority") {
    if (String(body.adminPassword || "") !== adminPassword) {
      return json({ error: "Invalid admin password" }, { status: 403 });
    }

    if (action === "admin-get-priority") {
      return json({
        priorityNames: await readPriorityNames(store),
        workerNames: await readWorkerNames(store)
      });
    }

    const priorityNames = await savePriorityNames(store, body.priorityNames);
    return json({
      priorityNames,
      workerNames: await readWorkerNames(store)
    });
  }

  const record = await store.get(key, { type: "json", consistency: "strong" });
  const ownsSession = record?.clientId === clientId;

  if (action === "release") {
    if (ownsSession) await store.delete(key);
    return json({ ok: true, owner: false, locked: false, workerName: "", expiresAt: null, ttlMs });
  }

  if (!isExpired(record, now) && !ownsSession) {
    const priorityNames = await readPriorityNames(store);
    const requesterRank = priorityRank(workerName, priorityNames);
    const ownerRank = priorityRank(record.workerName, priorityNames);

    if (requesterRank >= ownerRank) {
      return json({
        owner: false,
        locked: true,
        workerName: sanitizeWorkerName(record.workerName),
        priorityNames,
        expiresAt: record.expiresAt,
        ttlMs: Math.max(new Date(record.expiresAt).getTime() - now, 0)
      });
    }
  }

  const nextRecord = {
    clientId,
    workerName,
    startedAt: ownsSession && record.startedAt ? record.startedAt : new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString()
  };

  await store.setJSON(key, nextRecord);

  await new Promise((resolve) => setTimeout(resolve, 120));
  const confirmedRecord = await store.get(key, { type: "json", consistency: "strong" });
  if (confirmedRecord?.clientId !== clientId) {
    return json(publicSession(confirmedRecord, Date.now()));
  }

  return json({
    owner: true,
    locked: false,
    workerName,
    expiresAt: nextRecord.expiresAt,
    ttlMs
  });
};

export const config = {
  path: "/api/session"
};
