import assert from "node:assert/strict";
import test from "node:test";

import { summarizeEvents } from "../js/services/metrics.js";

test("summarizeEvents returns a complete zero summary for empty input", () => {
  assert.deepEqual(summarizeEvents([]), {
    total_interactions: 0,
    unique_guests: 0,
    camera_starts: 0,
    gesture_counts: {},
    pet_counts: {},
    average_session_ms: 0,
    last_event_at: null,
  });
});

test("summarizeEvents counts guests once and separates interaction types", () => {
  const summary = summarizeEvents([
    { event_type: "session_start", guest_id: "g1", recorded_at: "2026-10-26T10:00:00.000Z" },
    { event_type: "touch_started", guest_id: "g1", pet_id: "orange", recorded_at: "2026-10-26T10:01:00.000Z" },
    { event_type: "gesture_triggered", guest_id: "g2", pet_id: "shiba", gesture: "wave", recorded_at: "2026-10-26T10:02:00.000Z" },
    { event_type: "pet_action", guest_id: "g2", pet_id: "shiba", gesture: "spin", recorded_at: "2026-10-26T10:03:00.000Z" },
    { event_type: "camera_started", guest_id: "g2", recorded_at: "2026-10-26T10:04:00.000Z" },
    { event_type: "session_end", guest_id: "g2", value: 120000, recorded_at: "2026-10-26T10:05:00.000Z" },
  ]);

  assert.equal(summary.total_interactions, 3);
  assert.equal(summary.unique_guests, 2);
  assert.equal(summary.camera_starts, 1);
  assert.deepEqual(summary.gesture_counts, { spin: 1, wave: 1 });
  assert.deepEqual(summary.pet_counts, { orange: 1, shiba: 2 });
  assert.equal(summary.average_session_ms, 120000);
  assert.equal(summary.last_event_at, "2026-10-26T10:05:00.000Z");
});

test("summarizeEvents ignores malformed timestamps when finding the latest event", () => {
  const summary = summarizeEvents([
    { event_type: "touch_started", guest_id: "g1", recorded_at: "not-a-date" },
    { event_type: "touch_started", guest_id: "g1", recorded_at: "2026-10-26T12:00:00+08:00" },
  ]);

  assert.equal(summary.last_event_at, "2026-10-26T04:00:00.000Z");
});
