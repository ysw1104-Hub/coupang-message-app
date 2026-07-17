import { getStore } from "@netlify/blobs";

const recordsKey = "photo-board-records-v1";
const maxRecords = 200;
const maxImages = 4;
const maxImageLength = 1_250_000;
const statuses = new Set(["미확인", "확인완료", "처리완료", "배송X", "보류"]);

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

function sanitizeText(value, limit = 500) {
  return String(value || "").trim().replace(/\s+\n/g, "\n").slice(0, limit);
}

function sanitizeStatus(value) {
  const status = sanitizeText(value, 20);
  return statuses.has(status) ? status : "미확인";
}

function sanitizeWorkerName(value) {
  return sanitizeText(value, 12).replace(/\s+/g, " ");
}

function sanitizeImages(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((image) => String(image || ""))
    .filter((image) => /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(image))
    .filter((image) => image.length <= maxImageLength)
    .slice(0, maxImages);
}

function sortRecords(records) {
  return records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

async function readRecords(store) {
  const saved = await store.get(recordsKey, { type: "json", consistency: "strong" });
  const records = Array.isArray(saved?.records) ? saved.records : [];
  return sortRecords(records).slice(0, maxRecords);
}

async function writeRecords(store, records) {
  const cleanRecords = sortRecords(records).slice(0, maxRecords);
  await store.setJSON(recordsKey, {
    records: cleanRecords,
    updatedAt: new Date().toISOString()
  });
  return cleanRecords;
}

function createRecord(body, now) {
  const images = sanitizeImages(body.images);
  if (!images.length) return null;

  return {
    id: crypto.randomUUID(),
    status: sanitizeStatus(body.status),
    memo: sanitizeText(body.memo, 500),
    workerName: sanitizeWorkerName(body.workerName),
    images,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

export default async (request) => {
  const store = getStore("coupang-message-app");
  const now = new Date();

  if (request.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });

  if (request.method === "GET") {
    return json({ records: await readRecords(store) });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await readBody(request);
  const action = String(body.action || "create");
  const records = await readRecords(store);

  if (action === "create") {
    const record = createRecord(body, now);
    if (!record) return json({ error: "사진을 1장 이상 올려주세요." }, { status: 400 });

    const nextRecords = await writeRecords(store, [record, ...records]);
    return json({ record, records: nextRecords });
  }

  if (action === "update") {
    const id = sanitizeText(body.id, 80);
    const nextRecords = records.map((record) => {
      if (record.id !== id) return record;
      return {
        ...record,
        status: sanitizeStatus(body.status ?? record.status),
        memo: body.memo === undefined ? record.memo : sanitizeText(body.memo, 500),
        updatedAt: now.toISOString()
      };
    });

    return json({ records: await writeRecords(store, nextRecords) });
  }

  if (action === "delete") {
    const id = sanitizeText(body.id, 80);
    return json({ records: await writeRecords(store, records.filter((record) => record.id !== id)) });
  }

  return json({ error: "Unknown action" }, { status: 400 });
};

export const config = {
  path: "/api/photos"
};
