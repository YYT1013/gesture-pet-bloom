import assert from "node:assert/strict";
import test from "node:test";

import { renderDashboard } from "../js/dashboard-view.js";

class StubNode {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.textContent = "";
    this.className = "";
    this.style = { setProperty() {} };
  }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
}

const doc = { createElement: (tag) => new StubNode(tag) };
const textOf = (node) => [node.textContent, ...node.children.map(textOf)].filter(Boolean).join(" ");

test("renderDashboard shows six KPIs and sorted breakdowns", () => {
  const root = new StubNode();
  renderDashboard(root, {
    total_interactions: 24,
    unique_guests: 6,
    camera_starts: 9,
    average_session_ms: 65000,
    gesture_counts: { wave: 3, spin: 8 },
    pet_counts: { orange: 12, shiba: 4 },
    last_event_at: "2026-10-26T08:00:00.000Z",
  }, doc);
  const text = textOf(root);

  assert.match(text, /互动次数 24/);
  assert.match(text, /独立访客 6/);
  assert.match(text, /摄像头启动 9/);
  assert.match(text, /平均会话 1分05秒/);
  assert.match(text, /spin 8/);
  assert.match(text, /orange 12/);
});

test("renderDashboard keeps untrusted labels as text instead of markup", () => {
  const root = new StubNode();
  renderDashboard(root, {
    total_interactions: 1,
    pet_counts: { '<img src=x onerror=alert(1)>': 1 },
  }, doc);

  const text = textOf(root);
  assert.match(text, /<img src=x onerror=alert\(1\)> 1/);
  assert.equal(JSON.stringify(root).includes('innerHTML'), false);
});

test("renderDashboard renders an empty state", () => {
  const root = new StubNode();
  renderDashboard(root, {}, doc);
  assert.match(textOf(root), /还没有互动数据/);
});
