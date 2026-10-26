import { EventQueue } from "./event-queue.js";
import { summarizeEvents } from "./metrics.js";

const GUEST_KEY = "gesture-pet:guest-id";
const QUEUE_KEY = "gesture-pet:analytics-events";
const LOCAL_KEY = "gesture-pet:local-events";

function safeGet(storage, key) {
  try {
    return storage?.getItem(key) || null;
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch {
    // The app remains usable when storage is blocked.
  }
}

function defaultId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function isoTime(now) {
  const value = now();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function createAnalytics({
  repository = null,
  storage = globalThis.localStorage || null,
  now = () => new Date(),
  createId = defaultId,
  autoFlush = true,
} = {}) {
  let localEvents = [];
  try {
    const restored = JSON.parse(storage?.getItem(LOCAL_KEY) || "[]");
    if (Array.isArray(restored)) localEvents = restored.slice(-500);
  } catch {
    localEvents = [];
  }
  let guestId = safeGet(storage, GUEST_KEY);
  let session = null;
  let startedAt = null;
  let started = false;
  let stopped = false;
  let timer = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => {});

  const queue = new EventQueue({
    storage,
    key: QUEUE_KEY,
    send: async (events) => {
      await ready;
      if (repository) await repository.sendEvents(events);
    },
  });

  function normalize(eventType, payload = {}) {
    if (!session) throw new Error("Analytics session has not started");
    const value = Number(payload.value);
    return {
      session_id: session.session_id,
      guest_id: session.guest_id,
      event_type: eventType,
      pet_id: payload.petId || null,
      gesture: payload.gesture || null,
      value: Number.isFinite(value) ? value : 1,
      metadata: payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
      recorded_at: isoTime(now),
    };
  }

  async function start({ page = "/", device = {} } = {}) {
    if (started) return session;
    started = true;
    startedAt = Date.parse(isoTime(now));
    if (!guestId) {
      guestId = createId();
      safeSet(storage, GUEST_KEY, guestId);
    }
    session = {
      guest_id: guestId,
      session_id: createId(),
      page,
      started_at: isoTime(now),
      device,
    };

    try {
      if (repository) await repository.startSession(session);
      readyResolve();
    } catch (error) {
      readyReject(error);
      console.warn("[analytics] session start failed:", error);
    }

    track("session_start", { metadata: { page } });
    if (autoFlush) {
      timer = setInterval(() => { queue.flush(); }, 5000);
      if (typeof timer?.unref === "function") timer.unref();
    }
    return session;
  }

  function track(eventType, payload = {}) {
    if (!session || stopped) return Promise.resolve({ ok: true, sent: 0 });
    const event = normalize(eventType, payload);
    localEvents.push(event);
    if (localEvents.length > 500) localEvents.splice(0, localEvents.length - 500);
    safeSet(storage, LOCAL_KEY, JSON.stringify(localEvents));
    return queue.enqueue(event);
  }

  async function flush() {
    return queue.flush();
  }

  async function stop() {
    if (!session || stopped) return { ok: true, sent: 0 };
    if (timer) clearInterval(timer);
    const duration = Math.max(0, Date.parse(isoTime(now)) - startedAt);
    track("session_end", { value: duration });
    stopped = true;
    return queue.flush();
  }

  return {
    start,
    track,
    flush,
    stop,
    get isRemote() { return Boolean(repository); },
    getSession: () => session,
    localSummary: () => summarizeEvents(localEvents),
    localEvents: () => localEvents.slice(),
  };
}
