import assert from "node:assert/strict";
import test from "node:test";

import { shouldTrackTouch } from "../js/services/event-rules.js";

test("shouldTrackTouch emits only on the transition into contact", () => {
  assert.equal(shouldTrackTouch(false, true), true);
  assert.equal(shouldTrackTouch(true, true), false);
  assert.equal(shouldTrackTouch(true, false), false);
  assert.equal(shouldTrackTouch(false, false), false);
});
