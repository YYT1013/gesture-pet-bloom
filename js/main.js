/* ============================================================
 * main.js —— 总装配
 *
 * 每帧做六件事：
 *   1. 识别 → 指尖在画布上的像素坐标（24fps 节流）
 *   2. 触碰 → 换成本地坐标，判定摸到哪儿、是点还是摸
 *   3. 宠物 → 状态机 + 动作时间轴，算出这一帧的 pose
 *   4. 渲染 → 实景桌面 → 落地投影 → 宠物 → 情绪特效 → 统一光影
 *   5. 光标 → 指尖圈
 *   6. 音效 → 把宠物抛出的事件变成声音
 *
 * 性能：
 *   · 背景（实景照片 + 调色 + 压暗）在 resize 时一次性合成进离屏 canvas；
 *   · 宠物每层在加载时调好色，每帧只是 drawImage；
 *   · 画布 alpha:false + DPR 上限 1.5；
 *   · 帧函数包 try/catch，任何一帧报错都不会让 rAF 循环停死；
 *     连续掉帧自动降 DPR → 降识别帧率 → 降识别分辨率。
 * ============================================================ */

import { PETS, TOUCH } from "./config.js";
import { HandTracker } from "./hand.js";
import { TouchTracker } from "./touch.js";
import { Pet } from "./pet.js";
import { drawPet, drawPetShadow, drawMood, layout, loadAssets } from "./render.js";
import { loadScene, buildBackdrop, drawLightPass, drawLightSpill, SCENE } from "./scene.js";
import { Sound } from "./audio.js";
import { drawBloom, BLOOMS } from "./bloom.js";
import { buildUI } from "./ui.js";
import { initCustom, listSaved, recordToCfg, removePet } from "./custom.js";
import { createAnalytics } from "./services/analytics.js";
import { createSupabaseRepository, getSupabaseConfigFromEnv } from "./services/supabase.js";
import { shouldTrackTouch } from "./services/event-rules.js";

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;

/* ---------------- 画布 ---------------- */
const canvas = document.getElementById("stage");
const g = canvas.getContext("2d", { alpha: false, desynchronized: true });
const video = document.getElementById("cam");
const pip = document.getElementById("pipCanvas");
let W = 0, H = 0, DPR = 1;
let maxDPR = 1.5;                 // 自适应降级会下调
let bg = null;                    // 预渲染的背景（实景照片合成图）

function resize() {
  const r = canvas.getBoundingClientRect();
  DPR = Math.min(window.devicePixelRatio || 1, maxDPR);
  W = Math.max(1, Math.round(r.width));
  H = Math.max(1, Math.round(r.height));
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (pip) {
    const pr = pip.getBoundingClientRect();
    pip.width = Math.max(1, Math.round(pr.width * Math.min(DPR, 1.5)));
    pip.height = Math.max(1, Math.round(pr.height * Math.min(DPR, 1.5)));
  }
  bg = buildBackdrop(W, H, DPR);
}
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", () => setTimeout(resize, 220));

function drawBackdrop() {
  if (!bg) { g.fillStyle = "#e6d5bf"; g.fillRect(0, 0, W, H); return; }
  g.drawImage(bg, 0, 0, W, H);
}

/* ---------------- 全局状态 ---------------- */
const pets = PETS.slice();          // 内置 7 只 + 用户复刻的

const state = {
  petIndex: 0,
  sensNorm: (TOUCH.sensDefault - TOUCH.sensMin) / (TOUCH.sensMax - TOUCH.sensMin),
  vol: 0.72,
  showPts: true,
  showCam: true,
  bloomMode: false,
  bloomType: 0,
  started: false,
  demo: false,
  ready: false,
  showFps: false,
};

/* ---------------- 匿名互动分析 ----------------
 * 只上传统计事件，不上传摄像头画面、照片或宠物图层。Supabase 未配置时
 * 自动保留本地统计，所有互动功能保持原样。 */
const analyticsConfig = getSupabaseConfigFromEnv();
let analyticsRepository = null;
if (analyticsConfig.configured) {
  try {
    analyticsRepository = createSupabaseRepository(analyticsConfig);
  } catch (error) {
    console.warn("[analytics] Supabase 初始化失败，切换到本地统计", error);
  }
}
const analytics = createAnalytics({ repository: analyticsRepository });
analytics.start({
  page: location.pathname + location.search,
  device: {
    language: navigator.language,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    dpr: Math.round((window.devicePixelRatio || 1) * 10) / 10,
  },
}).catch(() => {});

const sensValue = () => lerp(TOUCH.sensMin, TOUCH.sensMax, state.sensNorm);

let pet = new Pet(pets[0]);
let petFade = 1;
const trackers = [new TouchTracker(), new TouchTracker()];
const sound = new Sound();
const hand = new HandTracker(video, pip);
let lastHandsSeen = 0;
let NOW = 0;

/* 无摄像头演示 / 鼠标测试用的虚拟指尖 */
const pointer = { x: -999, y: -999, inside: false };
const ptrTracker = new TouchTracker();

/* 开花彩蛋 */
let bloomOpen = 0.35, bloomYaw = 0.4;

/* ---------------- 复刻宠物 ---------------- */
const custom = initCustom({
  onCreated(cfg, saved) {
    pets.push(cfg);
    ui.setPets();
    loadAssets([cfg]).then(() => {
      ui.toast(saved ? `${cfg.name} 回来了 · 已存在这台设备` : `${cfg.name} 回来了`);
    });
    selectPet(pets.length - 1);
  },
  onOpenChange(on) {
    document.body.classList.toggle("modalOpen", on);
  },
});

async function selectPet(i) {
  if (i < 0 || i >= pets.length) return;
  const cfg = pets[i];
  if (!cfg) return;
  if (i !== state.petIndex) {
    state.petIndex = i;
    petFade = 0;
    if (!cfg.custom) ui.toast(cfg.full || cfg.name);
    await loadAssets([cfg]).catch(() => {});
    pet = new Pet(cfg);
    ui.setPet(i);
    analytics.track("pet_selected", { petId: cfg.id });
  }
}

/* ---------------- UI ---------------- */
const ui = buildUI(pets, {
  sens: state.sensNorm,
  vol: state.vol,
  showPts: state.showPts,
  showCam: state.showCam,
  onPet(i) { selectPet(i); },
  onSens(v) {
    state.sensNorm = v;
    ui.toast(`灵敏度 ${Math.round(lerp(TOUCH.sensMin, TOUCH.sensMax, v) * 1000)}‰`);
  },
  onVol(v) { state.vol = v; sound.setVolume(v); },
  onShowPts(v) { state.showPts = v; hand.showPts = v; if (!v) clearPip(); },
  onShowCam(v) {
    state.showCam = v;
    document.body.classList.toggle("nocam", !v);
  },
  onBloomToggle() {
    state.bloomMode = !state.bloomMode;
    ui.setBloomMode(state.bloomMode);
    ui.toast(state.bloomMode ? `开花彩蛋 · ${BLOOMS[state.bloomType].name}` : "回到撸宠");
    analytics.track("bloom_toggled", { value: state.bloomMode ? 1 : 0 });
  },
  onAdopt() { custom.open(); },
  async onStart(withCamera) {
    sound.ensure();
    sound.setVolume(state.vol);
    ui.hideStart();
    state.started = true;
    if (!withCamera) {
      state.demo = true;
      ui.toast("鼠标 = 手指，直接划过宠物就行");
      analytics.track("demo_started");
      return;
    }
    try {
      await hand.load();
      const st = await hand.openCamera();
      ui.setCameraState(true);
      ui.toast(`${st.width}×${st.height} · 把手伸进画面`);
      refreshCameras();
      analytics.track("camera_started", { metadata: { width: st.width, height: st.height } });
    } catch (err) {
      console.error(err);
      state.demo = true;
      ui.startError(hint(err));
      ui.hideStart();
      analytics.track("camera_failed", { metadata: { name: err?.name || "UnknownError" } });
    }
  },
});
ui.setPet(0);
ui.setBloomMode(false);
document.body.classList.add("nocam");
resize();

const adoptStart = document.getElementById("adoptStart");
if (adoptStart) adoptStart.addEventListener("click", () => custom.open());

function hint(err) {
  const n = err && err.name;
  if (n === "NotAllowedError") return "摄像头被拒绝了：点地址栏左侧的图标，把摄像头改成「允许」";
  if (n === "NotFoundError") return "没找到摄像头，先用鼠标演示吧";
  if (n === "NotReadableError") return "摄像头被别的程序占用了，关掉会议软件再试";
  return `摄像头打不开：${(err && err.message) || err}`;
}

async function refreshCameras() {
  const sel = document.getElementById("camSel");
  if (!sel) return;
  const cams = await HandTracker.cameras();
  sel.innerHTML = "";
  const cur = video.srcObject?.getVideoTracks()[0]?.getSettings().deviceId;
  cams.forEach((c, i) => {
    const o = document.createElement("option");
    o.value = c.deviceId;
    o.textContent = (c.label || `摄像头 ${i + 1}`).replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "");
    if (c.deviceId === cur) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = async () => {
    try { await hand.openCamera(sel.value); ui.toast("已切换摄像头"); }
    catch (e) { ui.toast(hint(e)); }
  };
}

/* ---------------- 素材：启动就加载 ---------------- */
async function boot() {
  const msg = document.getElementById("startMsg");
  try {
    /* 场景和宠物素材并行拉，场景没回来也能先用兜底底色跑起来 */
    const sceneP = loadScene().then((ok) => { if (ok) resize(); });
    const n = await loadAssets(PETS, (p) => {
      if (msg) msg.textContent = `正在准备宠物素材 ${Math.round(p * 100)}%`;
    });
    await sceneP;
    state.ready = n > 0;
    if (msg) msg.textContent = state.ready
      ? "画面只在本机处理，不会上传任何数据"
      : "素材缺失：请用 START-Windows.bat 启动（需要本地服务）";

    /* 上次保存的专属宠物 */
    const saved = await listSaved();
    if (saved.length) {
      const cfgs = saved.map(recordToCfg);
      cfgs.forEach((c) => pets.push(c));
      ui.setPets();
      await loadAssets(cfgs).catch(() => {});
      console.info(`[custom] 恢复 ${cfgs.length} 只已保存的宠物`);
    }
  } catch (e) {
    console.error("[boot] 素材加载失败", e);
    if (msg) msg.textContent = "素材加载失败：请用 START-Windows.bat 启动，不要直接双击 index.html";
  }
}
boot();
HandTracker.cameras().then(() => refreshCameras()).catch(() => {});

/* ---------------- 坐标换算：视频归一化 → 画布像素 ---------------- */
function videoToCanvas(p) {
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const s = Math.min(W / vw, H / vh);
  const ox = (W - vw * s) / 2;
  const oy = (H - vh * s) / 2;
  return { x: ox + (1 - p.x) * vw * s, y: oy + p.y * vh * s };
}

function clearPip() {
  if (!pip) return;
  pip.getContext("2d").clearRect(0, 0, pip.width, pip.height);
}

/* ---------------- 手势回调 ---------------- */
hand.onWave = (slot, dir) => {
  if (state.bloomMode) return;
  pet.run(dir, NOW);
  ui.toast(dir > 0 ? "往右跑 →" : "← 往左跑");
  analytics.track("gesture_triggered", { petId: pet.cfg.id, gesture: "wave", metadata: { direction: dir } });
  analytics.track("pet_action", { petId: pet.cfg.id, gesture: "run" });
};
hand.onOpen = () => {
  if (state.bloomMode) return;
  if (pet.spin(NOW)) {
    ui.toast("转了一圈");
    analytics.track("gesture_triggered", { petId: pet.cfg.id, gesture: "open_palm" });
    analytics.track("pet_action", { petId: pet.cfg.id, gesture: "spin" });
  }
};

/* ---------------- 听音效事件 ---------------- */
function playEvents() {
  while (pet.events.length) {
    const e = pet.events.shift();
    const fire = () => {
      if (e.type === "purr") sound.purr(pet.cfg);
      else sound.voice(pet.cfg, { soft: e.soft, short: e.short, low: e.low, squeak: e.squeak });
    };
    if (e.delay) setTimeout(fire, e.delay);
    else fire();
  }
}

/* ---------------- 每帧 ---------------- */
let last = 0;
let frameMs = 16;
let slowFrames = 0;
let degraded = 0;
let errOnce = false;
let lastContact = false;

function frame(now) {
  NOW = now;
  const raw = now - (last || now);
  last = now;
  const dt = Math.min(0.05, raw / 1000);
  frameMs += ((raw || 16) - frameMs) * 0.06;

  try {
    tick(dt, now);
  } catch (e) {
    console.error("[frame]", e);
    if (!errOnce) { errOnce = true; ui.toast("渲染异常，已跳过这一帧"); }
  }
  adaptQuality();
  requestAnimationFrame(frame);
}

function tick(dt, now) {
  /* 1. 指尖来源 */
  let touches = [];
  if (!state.demo && hand.ready) {
    const hands = hand.update(now);
    if (hands.length) lastHandsSeen = now;
    hands.forEach((hd, i) => {
      const pt = videoToCanvas(hd.pts[8]);      // 食指尖
      trackers[i].sample(pt.x, pt.y, now, pet);
      touches.push({ ...trackers[i].analyze(pet, sensValue(), now), pt, hand: hd });
    });
    if (now - lastHandsSeen > 400) trackers.forEach((t) => t.reset());
  } else if (state.demo && pointer.inside) {
    ptrTracker.sample(pointer.x, pointer.y, now, pet);
    touches.push({ ...ptrTracker.analyze(pet, sensValue(), now), pt: pointer });
  }

  const main = touches.length ? touches.reduce((a, b) => (a.d <= b.d ? a : b)) : null;
  const twoHands = touches.length === 2 && touches[0].contact && touches[1].contact;
  const info = main
    ? { ...main, twoHands }
    : { active: false, zone: null, d: 9, lx: 0, ly: 0, brushing: false, tap: false, twoHands: false };

  if (shouldTrackTouch(lastContact, info.contact)) {
    analytics.track("touch_started", {
      petId: pet.cfg.id,
      metadata: { zone: info.zone, brushing: Boolean(info.brushing), two_hands: Boolean(info.twoHands) },
    });
  }
  lastContact = Boolean(info.contact);

  /* 2. 宠物 */
  pet.update(dt, info, now);
  petFade = Math.min(1, petFade + dt * 3.2);

  /* 3. 渲染 —— 顺序决定「真实感」：
     实景 → 桌面高光 → 落地投影 → 宠物 → 情绪 → 全局光影 */
  drawBackdrop();

  if (state.bloomMode) {
    const target = main ? clamp(main.hand ? main.hand.pinch : 0) : 0.3;
    bloomOpen += (target - bloomOpen) * Math.min(1, dt * 6);
    bloomYaw += dt * 0.18;
    drawBloom(g, W, H, state.bloomType, bloomOpen, bloomYaw);
    drawLightPass(g, W, H);
    ui.setGesture(`开花 · ${Math.round(bloomOpen * 100)}%`, bloomOpen);
  } else {
    const gy = H * SCENE.groundY;
    layout(pet, W, H);                     // 影子要用到 dispH/cx/cy，先算
    drawLightSpill(g, W, H, pet.cx, gy, pet.dispH * 0.62);
    drawPetShadow(g, pet);

    g.save();
    g.globalAlpha = 0.15 + petFade * 0.85;
    drawPet(g, pet, W, H, now);
    g.restore();
    drawMood(g, pet, W, H, now);

    /* 这一层盖住场景 + 宠物 + 影子：三者吃同一束光 */
    drawLightPass(g, W, H);

    ui.setGesture(pet.gesture, pet.mood);
    drawCursor(touches);
  }

  if (state.showFps) {
    const fps = 1000 / Math.max(1, frameMs);
    g.save();
    g.font = "600 12px ui-monospace, monospace";
    g.fillStyle = fps > 50 ? "rgba(90,120,90,.75)" : fps > 30 ? "rgba(150,120,40,.8)" : "rgba(170,70,60,.85)";
    g.fillText(`${fps.toFixed(0)} fps · 识别 ${hand.costMs.toFixed(0)}ms · DPR ${DPR}`, 12, H - 12);
    g.restore();
  }

  /* 4. 音效 */
  playEvents();
}

function adaptQuality() {
  if (frameMs > 25) slowFrames++;
  else slowFrames = Math.max(0, slowFrames - 1);

  if (slowFrames > 100 && degraded < 2) {
    degraded++;
    slowFrames = 0;
    if (degraded === 1) {
      maxDPR = 1;
      resize();
      hand.maxFps = 20;
      console.info("[perf] 降级：DPR→1，识别 20fps");
    } else {
      hand.maxFps = 15;
      hand.detW = 320;
      console.info("[perf] 降级：识别 15fps / 320px");
    }
  }
}

/* 指尖光标：暖白色双描边，压在实景上也看得清 */
function drawCursor(touches) {
  for (const t of touches) {
    if (!t.pt) continue;
    if (!(t.d < TOUCH.hoverBand)) continue;
    const { x, y } = t.pt;
    const hot = t.contact;
    g.save();
    g.globalAlpha = hot ? 0.85 : 0.35;
    g.strokeStyle = "rgba(255,252,246,0.9)";
    g.lineWidth = hot ? 4.5 : 3.2;
    g.beginPath();
    g.arc(x, y, hot ? 15 : 11, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = hot ? "#e8896a" : "#b08a68";
    g.lineWidth = hot ? 2.4 : 1.5;
    g.beginPath();
    g.arc(x, y, hot ? 15 : 11, 0, Math.PI * 2);
    g.stroke();
    if (hot) {
      g.globalAlpha = 0.3;
      g.fillStyle = "#e8896a";
      g.beginPath();
      g.arc(x, y, 4.5, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }
}

/* ---------------- 输入 ---------------- */
function onPointer(e) {
  const r = canvas.getBoundingClientRect();
  pointer.x = e.clientX - r.left;
  pointer.y = e.clientY - r.top;
  pointer.inside = true;
}
canvas.addEventListener("pointermove", onPointer);
canvas.addEventListener("pointerdown", onPointer);
canvas.addEventListener("pointerleave", () => {
  pointer.inside = false;
  ptrTracker.reset();
});

window.addEventListener("keydown", (e) => {
  if (document.body.classList.contains("modalOpen")) return;
  const k = e.key;
  if (k >= "1" && k <= "9") {
    const i = +k - 1;
    if (pets[i]) selectPet(i);
  }
  if (k === "f" || k === "F") {
    state.bloomMode = !state.bloomMode;
    ui.setBloomMode(state.bloomMode);
    ui.toast(state.bloomMode ? "开花彩蛋" : "回到撸宠");
    analytics.track("bloom_toggled", { value: state.bloomMode ? 1 : 0 });
  }
  if (k === "b" || k === "B") {
    state.bloomType = (state.bloomType + 1) % BLOOMS.length;
    ui.toast(BLOOMS[state.bloomType].name);
  }
  if (k === "s" || k === "S") document.getElementById("panel").classList.toggle("open");
  if (k === "c" || k === "C") {
    state.showCam = !state.showCam;
    document.body.classList.toggle("nocam", !state.showCam);
  }
  if (k === "h" || k === "H") document.body.classList.toggle("minimal");
  if (k === "u" || k === "U") custom.open();

  /* 无摄像头时手动触发手势，方便验收 */
  if (state.bloomMode) return;
  if (k === "z" || k === "Z") {
    if (pet.spin(NOW)) {
      ui.toast("张开手 · 转一圈");
      analytics.track("pet_action", { petId: pet.cfg.id, gesture: "spin" });
    }
  }
  if (k === "x" || k === "X") {
    pet.roll(NOW);
    ui.toast("双手 · 打滚");
    analytics.track("pet_action", { petId: pet.cfg.id, gesture: "roll" });
  }
  if (k === ",") {
    pet.run(-1, NOW);
    ui.toast("← 往左跑");
    analytics.track("pet_action", { petId: pet.cfg.id, gesture: "run", metadata: { direction: -1 } });
  }
  if (k === ".") {
    pet.run(1, NOW);
    ui.toast("往右跑 →");
    analytics.track("pet_action", { petId: pet.cfg.id, gesture: "run", metadata: { direction: 1 } });
  }
});

window.addEventListener("keydown", (e) => {
  if (!state.bloomMode) return;
  if (e.key === "ArrowUp") bloomOpen = clamp(bloomOpen + 0.08);
  if (e.key === "ArrowDown") bloomOpen = clamp(bloomOpen - 0.08);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) last = 0;
});

window.addEventListener("pagehide", () => { analytics.stop(); });

/* ---------------- URL 参数 ----------------
 *   ?pet=3        第 4 只
 *   ?demo=1       跳过启动页，鼠标演示
 *   ?minimal=1    隐藏顶栏和 HUD
 *   ?sens=0.7     灵敏度 0~1
 *   ?bloom=1      直接进开花彩蛋
 *   ?fps=1        显示帧率
 *   ?upload=1     直接打开上传面板（给验收/截图用）
 */
{
  const q = new URLSearchParams(location.search);
  if (q.has("minimal")) document.body.classList.add("minimal");
  if (q.has("sens")) state.sensNorm = clamp(parseFloat(q.get("sens")) || 0);
  if (q.has("pet")) {
    const i = Math.max(0, Math.min(pets.length - 1, (+q.get("pet")) - 1));
    selectPet(i);
  }
  if (q.has("bloom")) {
    state.bloomMode = true;
    ui.setBloomMode(true);
    analytics.track("bloom_toggled", { value: 1, metadata: { source: "url" } });
  }
  if (q.has("fps")) state.showFps = true;
  if (q.has("demo")) {
    state.demo = true;
    state.started = true;
    ui.hideStart();
    analytics.track("demo_started", { metadata: { source: "url" } });
  }
  if (q.has("upload")) setTimeout(() => custom.open(), 600);
}

requestAnimationFrame(frame);

/* 方便控制台/自测页面驱动 */
window.__pet = {
  get pets() { return pets; },
  get pet() { return pet; },
  get scene() { return SCENE; },
  selectPet, custom, removePet, analytics,
};
