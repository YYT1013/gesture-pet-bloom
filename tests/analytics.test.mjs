import assert from "node:assert/strict";
import test from "node:test";

import { createAnalytics } from "../js/services/analytics.js";

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
}

function ids(...values) {
  let index = 0;
  return () => values[index++];
}

test("createAnalytics starts an anonymous session and standardizes events", async () => {
  const started = [];
  const sent = [];
  const repository = {
    startSession: async (payload) => started.push(payload),
    sendEvents: async (events) => sent.push(...events),
  };
  const analytics = createAnalytics({
    repository,
    storage: memoryStorage(),
    now: () => new Date("2026-10-26T08:00:00.000Z"),
    createId: ids("guest-1", "session-1"),
    autoFlush: false,
  });

  await analytics.start({ page: "/", device: { language: "zh-CN" } });
  analytics.track("gesture_triggered", { petId: "orange", gesture: "wave", metadata: { direction: 1 } });
  await analytics.flush();

  assert.equal(started.length, 1);
  assert.equal(started[0].session_id, "session-1");
  assert.equal(started[0].guest_id, "guest-1");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].event_type, "gesture_triggered");
  assert.equal(sent[1].pet_id, "orange");
  assert.equal(sent[1].gesture, "wave");
  assert.deepEqual(sent[1].metadata, { direction: 1 });
  assert.equal(sent[1].recorded_at, "2026-10-26T08:00:00.000Z");
});

test("createAnalytics keeps working and summarizing without Supabase", async () => {
  const analytics = createAnalytics({
    repository: null,
    storage: memoryStorage({ "gesture-pet:guest-id": "guest-local" }),
    now: () => new Date("2026-10-26T08:00:00.000Z"),
    createId: () => "session-local",
    autoFlush: false,
  });

  await analytics.start({ page: "/demo" });
  analytics.track("touch_started", { petId: "shiba", zone: "head" });

  assert.equal(analytics.isRemote, false);
  assert.equal(analytics.localSummary().total_interactions, 1);
  assert.equal(analytics.localSummary().pet_counts.shiba, 1);
});

test("stop records session duration and flushes the final batch", async () => {
  let clock = Date.parse("2026-10-26T08:00:00.000Z");
  const sent = [];
  const analytics = createAnalytics({
    repository: {
      startSession: async () => {},
      sendEvents: async (events) => sent.push(...events),
    },
    storage: memoryStorage(),
    now: () => new Date(clock),
    createId: ids("guest-stop", "session-stop"),
    autoFlush: false,
  });

  await analytics.start({ page: "/" });
  clock += 45000;
  await analytics.stop();

  const end = sent.find((event) => event.event_type === "session_end");
  assert.equal(end.value, 45000);
  assert.equal(sent.length, 2);
});

test("local-only analytics restores its summary on the dashboard page", async () => {
  const storage = memoryStorage({ "gesture-pet:guest-id": "guest-persisted" });
  const first = createAnalytics({
    repository: null,
    storage,
    now: () => new Date("2026-10-26T08:00:00.000Z"),
    createId: () => "session-one",
    autoFlush: false,
  });
  await first.start({ page: "/" });
  first.track("touch_started", { petId: "corgi", zone: "head" });

  const second = createAnalytics({
    repository: null,
    storage,
    now: () => new Date("2026-10-26T08:01:00.000Z"),
    createId: () => "session-two",
    autoFlush: false,
  });
  await second.start({ page: "/analytics.html" });

  assert.equal(second.localSummary().pet_counts.corgi, 1);
});
