const INTERACTION_EVENTS = new Set(["touch_started", "gesture_triggered", "pet_action"]);

function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function increment(map, key) {
  if (typeof key !== "string" || !key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

export function summarizeEvents(events = []) {
  const guests = new Set();
  const gestures = new Map();
  const pets = new Map();
  let totalInteractions = 0;
  let cameraStarts = 0;
  let sessionTotal = 0;
  let sessionCount = 0;
  let latest = 0;

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const type = event.event_type;
    if (typeof event.guest_id === "string" && event.guest_id) guests.add(event.guest_id);

    if (INTERACTION_EVENTS.has(type)) {
      totalInteractions++;
      increment(pets, event.pet_id);
      increment(gestures, event.gesture);
    }
    if (type === "camera_started") cameraStarts++;
    if (type === "session_end") {
      const duration = Number(event.value);
      if (Number.isFinite(duration) && duration >= 0) {
        sessionTotal += duration;
        sessionCount++;
      }
    }

    const timestamp = Date.parse(event.recorded_at || "");
    if (Number.isFinite(timestamp) && timestamp > latest) latest = timestamp;
  }

  return {
    total_interactions: totalInteractions,
    unique_guests: guests.size,
    camera_starts: cameraStarts,
    gesture_counts: sortedObject(gestures),
    pet_counts: sortedObject(pets),
    average_session_ms: sessionCount ? Math.round(sessionTotal / sessionCount) : 0,
    last_event_at: latest ? new Date(latest).toISOString() : null,
  };
}
