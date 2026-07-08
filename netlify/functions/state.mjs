import { getStore } from "@netlify/blobs";

const key = "shared-state";
const kstOffsetMs = 9 * 60 * 60 * 1000;
const resetHourKst = 19;

const defaultState = {
  mode: "D1상차",
  title: "D1상차",
  mixed: "없음",
  mixedLines: [[]],
  currentMixedLine: 0,
  places: [
    { name: "여의", time: "" },
    { name: "미니", time: "" },
    { name: "봉동", time: "" },
    { name: "호성", time: "" },
    { name: "익산", time: "" }
  ],
  feeders: [
    { name: "", time: "" },
    { name: "", time: "" }
  ],
  memo: ""
};

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

function cloneDefaultState() {
  return JSON.parse(JSON.stringify(defaultState));
}

function kstDate(now) {
  return new Date(now.getTime() + kstOffsetMs);
}

function hasReachedResetTime(now) {
  return kstDate(now).getUTCHours() >= resetHourKst;
}

function resetCycleFor(now) {
  const shifted = kstDate(now);
  if (shifted.getUTCHours() < resetHourKst) shifted.setUTCDate(shifted.getUTCDate() - 1);
  return shifted.toISOString().slice(0, 10);
}

async function applyDailyResetIfNeeded(store, record, now) {
  if (!record?.state) return { record: record || { state: null, updatedAt: null }, resetApplied: false };

  const resetCycle = resetCycleFor(now);
  if (record.resetCycle === resetCycle) return { record, resetApplied: false };
  if (!record.resetCycle && !hasReachedResetTime(now)) return { record, resetApplied: false };

  const resetRecord = {
    state: cloneDefaultState(),
    updatedAt: now.toISOString(),
    resetAt: now.toISOString(),
    resetCycle
  };

  await store.setJSON(key, resetRecord);
  return { record: resetRecord, resetApplied: true };
}

export default async (request) => {
  const store = getStore("coupang-message-app");
  const now = new Date();

  if (request.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });

  if (request.method === "GET") {
    const saved = await store.get(key, { type: "json", consistency: "strong" });
    const { record } = await applyDailyResetIfNeeded(store, saved, now);
    return json(record);
  }

  if (request.method === "PUT" || request.method === "POST") {
    const saved = await store.get(key, { type: "json", consistency: "strong" });
    const resetResult = await applyDailyResetIfNeeded(store, saved, now);
    if (resetResult.resetApplied) return json(resetResult.record);

    const body = await request.json().catch(() => null);
    const state = sanitizeState(body?.state || body);

    if (!state) {
      return json({ error: "Invalid state" }, { status: 400 });
    }

    const record = {
      state,
      updatedAt: now.toISOString(),
      resetCycle: resetCycleFor(now)
    };

    await store.setJSON(key, record);
    return json(record);
  }

  return json({ error: "Method not allowed" }, { status: 405 });
};

export const config = {
  path: "/api/state"
};
