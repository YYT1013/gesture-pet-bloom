import assert from "node:assert/strict";
import test from "node:test";

import { EventQueue } from "../js/services/event-queue.js";

function memoryStorage(initial = null) {
  const data = new Map();
  if (initial) data.set("events", JSON.stringify(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
}

test("EventQueue flushes a full batch and clears it after success", async () => {
  const batches = [];
  const storage = memoryStorage();
  const queue = new EventQueue({
    send: async (batch) => batches.push(batch),
    storage,
    key: "events",
    batchSize: 2,
  });

  await queue.enqueue({ id: 1 });
  assert.equal(batches.length, 0);
  await queue.enqueue({ id: 2 });

  assert.deepEqual(batches, [[{ id: 1 }, { id: 2 }]]);
  assert.deepEqual(queue.snapshot(), []);
  assert.equal(storage.getItem("events"), "[]");
});

test("EventQueue keeps events after a failed send", async () => {
  const queue = new EventQueue({
    send: async () => { throw new Error("offline"); },
    batchSize: 10,
  });
  queue.enqueue({ id: 1 });
  const result = await queue.flush();

  assert.equal(result.ok, false);
  assert.equal(result.error.message, "offline");
  assert.deepEqual(queue.snapshot(), [{ id: 1 }]);
});

test("EventQueue caps retained events at maxItems", () => {
  const queue = new EventQueue({
    send: async () => {},
    batchSize: 100,
    maxItems: 2,
  });
  queue.enqueue({ id: 1 });
  queue.enqueue({ id: 2 });
  queue.enqueue({ id: 3 });

  assert.deepEqual(queue.snapshot(), [{ id: 2 }, { id: 3 }]);
});

test("EventQueue restores persisted events", () => {
  const queue = new EventQueue({
    send: async () => {},
    storage: memoryStorage([{ id: 7 }]),
    key: "events",
  });

  assert.deepEqual(queue.snapshot(), [{ id: 7 }]);
});
