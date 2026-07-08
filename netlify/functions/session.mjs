import { getStore } from "@netlify/blobs";

const key = "edit-session";
const waitersKey = "edit-waiters";
const priorityKey = "worker-priority";
const workerNamesKey = "worker-names";
const ttlMs = 6 * 1000;
const waiterTtlMs = 12 * 1000;
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

async function readWaiters(store, now) {
  const saved = await store.get(waitersKey, { type: "json", consistency: "strong" });
  const waiters = Array.isArray(saved?.waiters) ? saved.waiters : [];
  const activeWaiters = waiters
    .filter((item) => item?.clientId && item?.expiresAt && new Date(item.expiresAt).getTime() > now)
    .map((item) => ({
      clientId: String(item.clientId).slice(0, 120),
      workerName: sanitizeWorkerName(item.workerName),
      expiresAt: item.expiresAt
    }))
    .filter((item) => item.workerName);

  if (activeWaiters.length !== waiters.length) {
    await store.setJSON(waitersKey, { waiters: activeWaiters, updatedAt: new Date(now).toISOString() });
  }

  return activeWaiters;
}

async function upsertWaiter(store, clientId, workerName, now) {
  const worker = sanitizeWorkerName(workerName);
  if (!worker) return [];

  const waiters = (await readWaiters(store, now)).filter((item) => item.clientId !== clientId);
  waiters.push({
    clientId,
    workerName: worker,
    expiresAt: new Date(now + waiterTtlMs).toISOString()
  });
  await store.setJSON(waitersKey, { waiters, updatedAt: new Date(now).toISOString() });
  return waiters;
}

async function removeWaiter(store, clientId, now) {
  const waiters = (await readWaiters(store, now)).filter((item) => item.clientId !== clientId);
  await store.setJSON(waitersKey, { waiters, updatedAt: new Date(now).toISOString() });
  return waiters;
}

function publicWaiterNames(waiters, ownerClientId = "") {
  return [...new Set(waiters
    .filter((item) => item.clientId !== ownerClientId)
    .map((item) => sanitizeWorkerName(item.workerName))
    .filter(Boolean))];
}

async function publicSession(store, record, now) {
  const waiters = await readWaiters(store, now);
  if (isExpired(record, now)) {
    return { locked: false, owner: false, workerName: "", waiters: publicWaiterNames(waiters), expiresAt: null, ttlMs };
  }

  return {
    locked: true,
    owner: false,
    workerName: sanitizeWorkerName(record.workerName),
    waiters: publicWaiterNames(waiters, record.clientId),
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
    return json(await publicSession(store, record, now));
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
    await removeWaiter(store, clientId, now);
    return json({ ok: true, owner: false, locked: false, workerName: "", waiters: [], expiresAt: null, ttlMs });
  }

  if (!isExpired(record, now) && !ownsSession) {
    const priorityNames = await readPriorityNames(store);
    const requesterRank = priorityRank(workerName, priorityNames);
    const ownerRank = priorityRank(record.workerName, priorityNames);

    if (requesterRank >= ownerRank) {
      const waiters = await upsertWaiter(store, clientId, workerName, now);
      return json({
        owner: false,
        locked: true,
        workerName: sanitizeWorkerName(record.workerName),
        waiters: publicWaiterNames(waiters, record.clientId),
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
  const waiters = await removeWaiter(store, clientId, now);

  await new Promise((resolve) => setTimeout(resolve, 120));
  const confirmedRecord = await store.get(key, { type: "json", consistency: "strong" });
  if (confirmedRecord?.clientId !== clientId) {
    return json(await publicSession(store, confirmedRecord, Date.now()));
  }

  return json({
    owner: true,
    locked: false,
    workerName,
    waiters: publicWaiterNames(waiters, clientId),
    expiresAt: nextRecord.expiresAt,
    ttlMs
  });
};

export const config = {
  path: "/api/session"
};
