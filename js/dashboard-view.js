const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const entries = (value) => Object.entries(value && typeof value === "object" ? value : {})
  .map(([name, count]) => [name, number(count)])
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

function formatDuration(ms) {
  const total = Math.max(0, Math.round(number(ms) / 1000));
  if (total < 60) return `${total}秒`;
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}分${seconds}秒`;
}

function make(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function metricCard(doc, label, value) {
  const card = make(doc, "article", "metricCard");
  card.append(make(doc, "span", "metricLabel", label), make(doc, "strong", "metricValue", value));
  return card;
}

function breakdown(doc, title, data, emptyText) {
  const section = make(doc, "section", "breakdown");
  section.append(make(doc, "h2", "", title));
  const list = make(doc, "div", "barList");
  const rows = entries(data);
  if (!rows.length) {
    list.append(make(doc, "p", "empty", emptyText));
  } else {
    const maximum = Math.max(1, ...rows.map(([, count]) => count));
    for (const [name, count] of rows) {
      const row = make(doc, "div", "barRow");
      const head = make(doc, "div", "barHead");
      head.append(make(doc, "span", "barName", name), make(doc, "b", "barCount", count));
      const track = make(doc, "div", "barTrack");
      const fill = make(doc, "i", "barFill");
      fill.style.setProperty("width", `${Math.max(4, (count / maximum) * 100)}%`);
      track.append(fill);
      row.append(head, track);
      list.append(row);
    }
  }
  section.append(list);
  return section;
}

export function renderDashboard(root, metrics = {}, doc = globalThis.document) {
  const total = number(metrics.total_interactions);
  const guests = number(metrics.unique_guests);
  const cameras = number(metrics.camera_starts);
  const average = number(metrics.average_session_ms);
  const gestureRows = entries(metrics.gesture_counts);
  const petRows = entries(metrics.pet_counts);
  const topPet = petRows.length ? `${petRows[0][0]} · ${petRows[0][1]}` : "暂无";

  const summary = make(doc, "section", "metricGrid");
  summary.append(
    metricCard(doc, "互动次数", total),
    metricCard(doc, "独立访客", guests),
    metricCard(doc, "摄像头启动", cameras),
    metricCard(doc, "平均会话", formatDuration(average)),
    metricCard(doc, "手势种类", gestureRows.length),
    metricCard(doc, "宠物偏好", topPet),
  );

  const breakdownGrid = make(doc, "section", "breakdownGrid");
  breakdownGrid.append(
    breakdown(doc, "手势分布", metrics.gesture_counts, "还没有手势记录"),
    breakdown(doc, "宠物偏好", metrics.pet_counts, "还没有宠物互动记录"),
  );

  const footer = make(doc, "p", "dashboardNote");
  footer.textContent = total || guests
    ? `最近记录：${metrics.last_event_at ? new Date(metrics.last_event_at).toLocaleString("zh-CN") : "本地会话"}`
    : "还没有互动数据。返回互动页开启摄像头或鼠标演示后，再来查看。";

  root.replaceChildren(summary, breakdownGrid, footer);
  return metrics;
}
