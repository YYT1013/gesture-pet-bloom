import assert from "node:assert/strict";
import test from "node:test";

import { parseSupabaseConfig } from "../js/services/supabase.js";

test("parseSupabaseConfig reports an unconfigured client for empty values", () => {
  const config = parseSupabaseConfig({});
  assert.equal(config.configured, false);
  assert.equal(config.url, "");
  assert.match(config.error, /未配置/);
});

test("parseSupabaseConfig rejects malformed and insecure remote URLs", () => {
  const malformed = parseSupabaseConfig({ VITE_SUPABASE_URL: "not-a-url", VITE_SUPABASE_ANON_KEY: "key" });
  const insecure = parseSupabaseConfig({ VITE_SUPABASE_URL: "http://example.com", VITE_SUPABASE_ANON_KEY: "key" });
  assert.equal(malformed.configured, false);
  assert.equal(insecure.configured, false);
});

test("parseSupabaseConfig accepts a standard HTTPS project URL", () => {
  const config = parseSupabaseConfig({
    VITE_SUPABASE_URL: "https://example.supabase.co/",
    VITE_SUPABASE_ANON_KEY: "public-anon-key",
  });
  assert.deepEqual(config, {
    configured: true,
    url: "https://example.supabase.co",
    anonKey: "public-anon-key",
    error: "",
  });
});
