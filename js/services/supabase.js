import { createClient } from "@supabase/supabase-js";

export function parseSupabaseConfig(env = {}) {
  const rawUrl = String(env.VITE_SUPABASE_URL || "").trim();
  const anonKey = String(env.VITE_SUPABASE_ANON_KEY || "").trim();
  if (!rawUrl || !anonKey) {
    return { configured: false, url: rawUrl, anonKey, error: "Supabase 未配置" };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { configured: false, url: rawUrl, anonKey, error: "Supabase URL 格式错误" };
  }
  const local = ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    return { configured: false, url: rawUrl, anonKey, error: "Supabase URL 必须使用 HTTPS" };
  }

  return {
    configured: true,
    url: parsed.href.replace(/\/$/, ""),
    anonKey,
    error: "",
  };
}

export function createSupabaseRepository(config, clientFactory = createClient) {
  if (!config?.configured) throw new Error(config?.error || "Supabase 未配置");
  const client = clientFactory(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    client,
    async startSession(session) {
      const { error } = await client.rpc("start_analytics_session", {
        p_guest_id: session.guest_id,
        p_session_id: session.session_id,
        p_page: session.page,
        p_device: session.device || {},
      });
      if (error) throw error;
    },
    async sendEvents(events) {
      if (!events.length) return;
      const { error } = await client.from("interaction_events").insert(events);
      if (error) throw error;
    },
    async getDashboard() {
      const { data, error } = await client.rpc("analytics_dashboard");
      if (error) throw error;
      return data;
    },
  };
}

export function getSupabaseConfigFromEnv() {
  const env = typeof import.meta.env === "object" ? import.meta.env : {};
  return parseSupabaseConfig(env);
}
