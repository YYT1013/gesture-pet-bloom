#!/usr/bin/env node
/* ============================================================
 * e2e-cdp.mjs —— 用 CDP 驱动无头 Edge 做真实浏览器验收
 *
 * 为什么不用 --dump-dom：
 *   --virtual-time-budget 会把计时器直接快进，IndexedDB 这类走浏览器
 *   异步任务的 API 永远等不到回调，测不出结果（会一直卡在「running…」）。
 *   改用 CDP：等页面自己把 document.title 改成 PASS/FAIL 再取正文。
 *
 * 用法：
 *   node tools/e2e-cdp.mjs                  # 跑 _e2e.html 自检页
 *   node tools/e2e-cdp.mjs shots            # 另存 index.html 的真实截图
 *   node tools/e2e-cdp.mjs ui               # 检查真实页面的布局（弹窗/宠物条/溢出）
 * ============================================================ */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9333;
const args = process.argv.slice(2);
const positionalBase = args.find((arg) => /^https?:\/\//i.test(arg));
const BASE = (positionalBase || process.env.PET_BASE || "http://127.0.0.1:4173").replace(/\/+$/, "");
const EDGE = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) { console.error("找不到 Edge"); process.exit(1); }

const PROFILE = "C:/Users/Lenovo/AppData/Local/Temp/edgeprof_pet";
const shots = args.includes("shots");
const uiCheck = args.includes("ui");

const proc = spawn(EDGE, [
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });

async function json(path, init) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  return r.json();
}

/* 等 DevTools 端口起来 */
let ver = null;
for (let i = 0; i < 40; i++) {
  try { ver = await json("/json/version"); break; } catch { await sleep(250); }
}
if (!ver) { console.error("DevTools 没起来"); proc.kill(); process.exit(1); }

/* 新开一个标签页 */
const tab = await json(`/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
const consoleLog = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  } else if (m.method === "Runtime.consoleAPICalled") {
    consoleLog.push(m.params.type + ": " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  } else if (m.method === "Runtime.exceptionThrown") {
    consoleLog.push("EXCEPTION: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expr, awaitPromise = false) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
  return r.result.value;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

async function goto(url) {
  await send("Page.navigate", { url });
  await sleep(700);
}

/* 轮询页面里的完成标志 */
async function waitFor(expr, timeout = 120000, label = "条件") {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evaluate(expr)) return true; } catch {}
    await sleep(400);
  }
  throw new Error(`等待超时：${label}`);
}

let exitCode = 0;
try {
  if (shots) {
    /* ---- 真实页面截图 ---- */
    mkdirSync("docs", { recursive: true });
    const jobs = [
      ["docs/live-desktop.jpg", `${BASE}/index.html?demo=1&pet=1`],
      ["docs/live-dog.jpg", `${BASE}/index.html?demo=1&pet=4`],
      ["docs/live-hamster.jpg", `${BASE}/index.html?demo=1&pet=7`],
      ["docs/live-upload.jpg", `${BASE}/index.html?demo=1&upload=1`],
    ];
    for (const [file, url] of jobs) {
      await goto(url);
      await sleep(2600);
      const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log("已截图", file);
    }
    /* 手机竖屏 */
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await goto(`${BASE}/index.html?demo=1&pet=2`);
    await sleep(2600);
    const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    writeFileSync("docs/live-phone.jpg", Buffer.from(data, "base64"));
    console.log("已截图 docs/live-phone.jpg");

    /* 数据看板：先写一条本地统计，再截桌面与手机视图 */
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await goto(`${BASE}/index.html?demo=1`);
    await waitFor('Boolean(window.__pet && window.__pet.analytics)', 20000, "分析服务启动");
    await evaluate('window.__pet.analytics.track("touch_started", { petId: "orange" }), window.__pet.analytics.track("gesture_triggered", { petId: "orange", gesture: "wave" }), 1');
    await goto(`${BASE}/analytics.html`);
    await waitFor('document.querySelectorAll(".metricCard").length === 6', 20000, "数据看板渲染");
    const desktopDash = await send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    writeFileSync("docs/analytics-desktop.jpg", Buffer.from(desktopDash.data, "base64"));
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await goto(`${BASE}/analytics.html`);
    await waitFor('document.querySelectorAll(".metricCard").length === 6', 20000, "手机数据看板渲染");
    const phoneDash = await send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    writeFileSync("docs/analytics-phone.jpg", Buffer.from(phoneDash.data, "base64"));
    console.log("已截图数据看板桌面与手机视图");
  } else if (uiCheck) {
    /* ---- 真实页面布局检查 ---- */
    const probe = `(() => {
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
                 visible: b.width > 0 && b.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity > 0.05 }; };
      const chips = [...document.querySelectorAll("#pets .chip")];
      /* 只看「真正把文档撑宽」的元素：chip 在横向滚动容器里超出可视区是正常的，
         只有 documentElement.scrollWidth 变大才叫横向溢出 */
      const docWide = document.documentElement.scrollWidth > innerWidth + 1;
      const over = !docWide ? [] : [...document.querySelectorAll("body *")].filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.right > innerWidth + 1.5 && getComputedStyle(el).position !== "fixed";
      }).map((el) => el.className || el.tagName).slice(0, 5);
      /* 第一个 chip 必须能滚到（左边界不能被顶出容器） */
      const pets = document.getElementById("pets");
      const firstChipOK = !chips.length || chips[0].getBoundingClientRect().left >= pets.getBoundingClientRect().left - 1.5;
      return JSON.stringify({
        vw: innerWidth, vh: innerHeight,
        scrollW: document.documentElement.scrollWidth,
        chips: chips.length,
        chipW: chips.length ? Math.round(chips[0].getBoundingClientRect().width) : 0,
        adopt: r(document.getElementById("adopt")),
        canvas: r(document.getElementById("stage")),
        modalOn: document.body.classList.contains("modalOpen"),
        sheet: r(document.querySelector(".modal.on .sheet")),
        drop: r(document.querySelector(".modal.on .drop")),
        gen: r(document.querySelector(".modal.on #genBtn")),
        privacy: (document.querySelector(".modal.on .privacy") || {}).innerText || "",
        overflow: over,
        docWide,
        firstChipOK,
        petId: window.__pet ? window.__pet.pet.cfg.id : null,
        sceneReady: window.__pet ? window.__pet.scene.ready : null,
      });
    })()`;

    await goto(`${BASE}/index.html?demo=1&pet=1`);
    await waitFor('Boolean(window.__pet && window.__pet.scene.ready)', 20000, "首页实景加载");
    await sleep(350);
    const before = JSON.parse(await evaluate(probe));
    const canvasAlive = await evaluate(`(() => {
      const c = document.getElementById("stage");
      const g = c.getContext("2d");
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let low = 255, high = 0;
      for (let y = 0; y < c.height; y += 120) {
        for (let x = 0; x < c.width; x += 120) {
          const i = (y * c.width + x) * 4;
          low = Math.min(low, d[i], d[i + 1], d[i + 2]);
          high = Math.max(high, d[i], d[i + 1], d[i + 2]);
        }
      }
      return high - low > 20;
    })()`);
    /* 点「上传我的专属宠物」看弹窗 */
    await evaluate('document.getElementById("adopt").click(), 1');
    await sleep(600);
    const after = JSON.parse(await evaluate(probe));

    const rows = [
      ["宠物条 chip 数", before.chips, before.chips === 7],
      ["实景已加载", before.sceneReady, before.sceneReady === true],
      ["画布尺寸", `${before.canvas.w}×${before.canvas.h}`, before.canvas.w > 600],
      ["「上传我的专属宠物」按钮", before.adopt && before.adopt.visible ? "可见" : "不可见", !!(before.adopt && before.adopt.visible)],
      ["点开后 modalOpen", after.modalOn, after.modalOn === true],
      ["弹窗面板", after.sheet ? `${after.sheet.w}×${after.sheet.h}` : "无", !!(after.sheet && after.sheet.visible)],
      ["选择照片区", after.drop && after.drop.visible ? "可见" : "不可见", !!(after.drop && after.drop.visible)],
      ["隐私提示文案", after.privacy.includes("不会保存") && after.privacy.includes("不会泄露") ? "包含两项承诺" : after.privacy, after.privacy.includes("不会保存")],
      ["横向溢出", before.docWide ? before.overflow.join(",") : "无", before.docWide === false],
      ["首个 chip 可滚到", before.firstChipOK ? "是" : "否", before.firstChipOK === true],
      ["画布非空白", canvasAlive ? "是" : "否", canvasAlive === true],
    ];
    let f = 0;
    for (const [k, v, okFlag] of rows) {
      if (!okFlag) f++;
      console.log(`${okFlag ? "  ok  " : "  FAIL"}  ${k}：${v}`);
    }

    /* 手机竖屏 */
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await goto(`${BASE}/index.html?demo=1&pet=1`);
    await waitFor('Boolean(window.__pet && window.__pet.scene.ready)', 20000, "手机实景加载");
    await sleep(350);
    const m = JSON.parse(await evaluate(probe));
    const mOk = m.docWide === false && m.chips === 7 && m.firstChipOK === true;
    if (!mOk) f++;
    console.log(`${mOk ? "  ok  " : "  FAIL"}  手机 390×844：chip ${m.chips} 个 · 溢出 ${m.docWide ? m.overflow.join(",") : "无"} · 画布 ${m.canvas.w}×${m.canvas.h}`);

    /* 数据看板：先写一条本地互动，确认跨页面汇总和移动端布局 */
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await goto(`${BASE}/index.html?demo=1`);
    await waitFor('Boolean(window.__pet && window.__pet.analytics)', 20000, "分析服务启动");
    await evaluate('window.__pet.analytics.track("touch_started", { petId: "orange", metadata: { zone: "head" } }), 1');
    await goto(`${BASE}/analytics.html`);
    await waitFor('document.querySelectorAll(".metricCard").length === 6', 20000, "数据看板渲染");
    const dashboard = await evaluate(`(() => ({
      metrics: document.querySelectorAll(".metricCard").length,
      source: document.getElementById("source").textContent,
      interactions: [...document.querySelectorAll(".metricCard")].map((n) => n.innerText).join(" | "),
      overflow: document.documentElement.scrollWidth > innerWidth + 1
    }))()`);
    const dashboardOk = dashboard.metrics === 6 && dashboard.interactions.includes("互动次数") && !dashboard.overflow;
    if (!dashboardOk) f++;
    console.log(`${dashboardOk ? "  ok  " : "  FAIL"}  数据看板：${dashboard.metrics} 个指标 · ${dashboard.source} · 溢出 ${dashboard.overflow ? "有" : "无"}`);
    console.log(f ? `\n布局问题 ${f} 项` : "\n布局全部正常");
    exitCode = f ? 1 : 0;
  } else {
    /* ---- 自检页 ---- */
    await goto(`${BASE}/tools/e2e.html`);
    await waitFor('document.title.startsWith("E2E-") && document.title !== "E2E-RUNNING"', 180000, "自检页跑完");
    const title = await evaluate("document.title");
    const text = await evaluate('document.getElementById("out").innerText');
    console.log(text);
    console.log("\n标题：", title);
    if (consoleLog.length) {
      console.log("\n控制台：");
      consoleLog.slice(0, 20).forEach((l) => console.log("  " + l));
    }
    exitCode = title === "E2E-PASS" ? 0 : 1;
  }
} catch (e) {
  console.error("失败：", e.message);
  if (consoleLog.length) consoleLog.slice(0, 20).forEach((l) => console.error("  " + l));
  exitCode = 1;
}

ws.close();
proc.kill();
await sleep(300);
process.exit(exitCode);
