import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = () => readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");

test("schema defines the three analytics tables with RLS", () => {
  const source = sql();
  for (const table of ["guests", "sessions", "interaction_events"]) {
    assert.match(source, new RegExp(`create table if not exists public\\.${table}`, "i"));
    assert.match(source, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
});

test("schema exposes only the session-start and dashboard RPCs to anonymous callers", () => {
  const source = sql();
  assert.match(source, /create or replace function public\.start_analytics_session/i);
  assert.match(source, /create or replace function public\.analytics_dashboard/i);
  assert.match(source, /grant execute on function public\.start_analytics_session[\s\S]*to anon/i);
  assert.match(source, /grant execute on function public\.analytics_dashboard[\s\S]*to anon/i);
  assert.doesNotMatch(source, /create policy[^;]+for select/i);
});

test("schema allows anonymous event inserts but revokes direct table reads", () => {
  const source = sql();
  assert.match(source, /create policy "anon insert interaction events"/i);
  assert.match(source, /grant insert on table public\.interaction_events to anon/i);
  assert.match(source, /revoke all on table public\.guests, public\.sessions, public\.interaction_events from anon/i);
});
