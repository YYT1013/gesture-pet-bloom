import { renderDashboard } from "./dashboard-view.js";
import { summarizeEvents } from "./services/metrics.js";
import { createSupabaseRepository, getSupabaseConfigFromEnv } from "./services/supabase.js";

const root = document.getElementById("dashboard");
const source = document.getElementById("source");
const refresh = document.getElementById("refresh");

function readLocalEvents() {
  try {
    const events = JSON.parse(localStorage.getItem("gesture-pet:local-events") || "[]");
    return Array.isArray(events) ? events : [];
  } catch {
    return [];
  }
}

async function load() {
  refresh.disabled = true;
  source.textContent = "读取中";
  source.dataset.state = "loading";
  const config = getSupabaseConfigFromEnv();

  if (config.configured) {
    try {
      const repository = createSupabaseRepository(config);
      const metrics = await repository.getDashboard();
      renderDashboard(root, metrics);
      source.textContent = "Supabase 在线数据";
      source.dataset.state = "online";
      return;
    } catch (error) {
      console.warn("[analytics-page] Supabase 读取失败，使用本地统计", error);
    }
  }

  const events = readLocalEvents();
  renderDashboard(root, summarizeEvents(events));
  source.textContent = config.configured ? "本地统计 · 云端暂不可用" : "本地统计模式";
  source.dataset.state = config.configured ? "fallback" : "local";
}

refresh.addEventListener("click", load);
load().finally(() => { refresh.disabled = false; });
