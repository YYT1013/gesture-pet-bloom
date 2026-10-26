/* ============================================================
 * hand.js —— 手部识别层
 *
 * 职责很单一：把摄像头画面变成「每只手的 21 个平滑关键点 + 几个手势标量」。
 * 不关心宠物、不碰画面，方便单独替换或调试。
 *
 * 沿用了原「指尖开花」项目里被验证过的三条经验：
 *   1. 显示用高清（1280 宽），交给模型识别的缩到 640 宽 —— 清晰和流畅互不影响；
 *   2. 所有数值先过 One Euro 滤波 —— 手静止时压住抖动，快动作时跟得紧；
 *   3. 多手时按屏幕横向位置左右排序 —— 双手场景下身份不会来回跳。
 * ============================================================ */

import { FilesetResolver, HandLandmarker } from "../lib/vision_bundle.mjs";
import { LM, GEST } from "./config.js";

/* ---------- One Euro 滤波器 ----------
 * minCutoff 越小越稳、beta 越大越跟手。dCutoff 是速度的滤波。
 * 指尖用它比用滑动平均好：抬手时不拖尾，悬停时不发抖。 */
function oneEuro(minCutoff = 1.2, beta = 8, dCutoff = 1.0) {
  let x = null, dx = 0, last = 0;
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  return (v, t) => {
    if (x === null || t - last > 500) { x = v; dx = 0; last = t; return v; }
    const dt = Math.max(0.001, (t - last) / 1000);
    last = t;
    dx += alpha(dCutoff, dt) * ((v - x) / dt - dx);
    x += alpha(minCutoff + beta * Math.abs(dx), dt) * (v - x);
    return x;
  };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// 手指伸直：指尖离手腕比第二关节离手腕远 12% 以上
const extended = (h, tip, pip) => dist(h[LM.wrist], h[tip]) > dist(h[LM.wrist], h[pip]) * 1.12;

/* 每只手的滤波器组（滑槽 0 / 1） */
function makeFilters() {
  const pts = Array.from({ length: 21 }, () => [oneEuro(), oneEuro()]);
  return {
    pts,
    pinch: oneEuro(1.0, 4),
    spread: oneEuro(1.0, 4),
    roll: oneEuro(0.8, 2),
    finger(hand, k, x, y, t) {
      return { x: this.pts[k][0](x, t), y: this.pts[k][1](y, t) };
    },
  };
}

/* 挥手检测：450ms 内手掌横向移动超过画面宽度的 16%，且横向明显大于竖向 */
const SWIPE_MS = 450;
const SWIPE_DIST = 0.16;

export class HandTracker {
  constructor(video, overlay) {
    this.video = video;
    this.overlay = overlay;        // 关键点画在这块 canvas 上（可以为 null）
    this.landmarker = null;
    this.ready = false;
    this.lastVideoTime = -1;
    this.hands = [];               // 已平滑、已按左右排序
    this.showPts = true;           // 是否画关键点（设置面板可关）
    this.filters = [makeFilters(), makeFilters()];
    this.swipe = [[], []];
    this.lastWave = [0, 0];
    this.waveDir = [0, 0];
    this.slotsSeen = [-1e9, -1e9];
    this.onWave = null;            // (slot, dir) => void
    /* ---- 性能开关 ----
     * 识别是整个页面最重的一步（MediaPipe 同步跑在主线程），
     * 把它压到 24fps + 384 宽，帧时间直接从 40~60ms 掉到 10~16ms。
     * 指尖位置有 One Euro 滤波补平滑，24fps 的采样看起来也是连续的。 */
    this.maxFps = 24;
    this.detW = 384;
    this.lastRun = 0;
    this.costMs = 0;          // 上一帧识别耗时，main 用它做自适应降级
    this.openSince = [-1, -1];
    this.lastOpen = -1e9;
    this.onOpen = null;       // (slot) => void

    // 识别用的缩小画面
    this.det = document.createElement("canvas");
    this.detCtx = this.det.getContext("2d", { willReadFrequently: false });
  }

  /* ---------- 模型加载 ---------- */
  async load() {
    if (this.ready) return;
    const fileset = await FilesetResolver.forVisionTasks(new URL("../lib/wasm", import.meta.url).href);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: new URL("../models/hand_landmarker.task", import.meta.url).href, delegate },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.3,
      minTrackingConfidence: 0.3,
    });
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, opts("GPU"));
    } catch (e) {
      // 极少数机器 GPU 委托初始化失败，退到 CPU —— 帧率低一些但能跑
      console.warn("[hand] GPU 委托失败，回退 CPU：", e);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, opts("CPU"));
    }
    this.ready = true;
  }

  /* ---------- 摄像头 ---------- */
  async openCamera(deviceId) {
    if (this.video.srcObject) {
      this.video.srcObject.getTracks().forEach((t) => t.stop());
      this.video.srcObject = null;
      await new Promise((r) => setTimeout(r, 260)); // 让旧设备彻底释放
    }
    const which = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 }, ...which },
        audio: false,
      });
    } catch (err) {
      if (err.name !== "OverconstrainedError") throw err;
      stream = await navigator.mediaDevices.getUserMedia({ video: which, audio: false });
    }
    this.video.srcObject = stream;
    await this.video.play();
    this.lastVideoTime = -1;
    return stream.getVideoTracks()[0].getSettings();
  }

  static async cameras() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "videoinput")
      .filter((c) => !/桌上视角|desk view/i.test(c.label));
  }

  /* ---------- 每帧识别 ---------- */
  update(now) {
    if (!this.landmarker || this.video.readyState < 2) return this.hands;
    if (this.video.currentTime === this.lastVideoTime) return this.hands;
    // 节流：不到间隔时间就复用上一次的关键点（frame 循环照常跑，动画不受影响）
    if (now - this.lastRun < 1000 / this.maxFps) return this.hands;
    this.lastRun = now;
    this.lastVideoTime = this.video.currentTime;

    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return this.hands;

    // 识别用 640 宽的小图
    const dw = Math.min(this.detW, vw), dh = Math.round((vh * dw) / vw);
    if (this.det.width !== dw) { this.det.width = dw; this.det.height = dh; }
    this.detCtx.drawImage(this.video, 0, 0, dw, dh);

    const t0 = performance.now();
    const res = this.landmarker.detectForVideo(this.det, now);
    this.costMs = performance.now() - t0;
    const raw = res.landmarks || [];

    // 画面是镜像的：原始 x 越大，屏幕上越靠左 —— 按 x 降序排，就是屏幕左 → 右
    const sorted = [...raw].sort((a, b) => b[0].x - a[0].x).slice(0, 2);

    // 手数变化时重排了槽位，清掉挥手记录以免误判
    if (sorted.length !== this.hands.length) this.swipe.forEach((s) => (s.length = 0));

    const out = [];
    sorted.forEach((lm, slot) => {
      const f = this.filters[slot];
      const pts = lm.map((p, k) => f.finger(lm, k, p.x, p.y, now));
      const m = this.metrics(pts, f, now);
      const palm = this.palmCenter(pts);
      // 挥手
      const sw = this.swipe[slot];
      sw.push({ x: palm.x, y: palm.y, t: now });
      while (sw.length && now - sw[0].t > SWIPE_MS) sw.shift();
      if (sw.length > 2) {
        const a = sw[0], b = sw[sw.length - 1];
        const dx = -(b.x - a.x);              // 换算成屏幕方向
        const dy = b.y - a.y;
        if (Math.abs(dx) > SWIPE_DIST && Math.abs(dx) > Math.abs(dy) * 1.5 &&
            now - this.lastWave[slot] > 700) {
          const dir = dx > 0 ? 1 : -1;
          const isReturn = dir === -this.waveDir[slot] && now - this.lastWave[slot] < 1200;
          if (!isReturn) {
            this.waveDir[slot] = dir;
            if (this.onWave) this.onWave(slot, dir);
          }
          this.lastWave[slot] = now;
          sw.length = 0;
        }
      }
      // ---- 张开五指（转圈手势）----
      const isOpen = m.spread > GEST.openSpread && m.count >= GEST.openFingers;
      if (isOpen) {
        if (this.openSince[slot] < 0) this.openSince[slot] = now;
        if (now - this.openSince[slot] >= GEST.openHoldMs &&
            now - this.lastOpen >= GEST.openCooldownMs) {
          this.lastOpen = now;
          this.openSince[slot] = -1;
          if (this.onOpen) this.onOpen(slot);
        }
      } else {
        this.openSince[slot] = -1;
      }

      this.slotsSeen[slot] = now;
      out.push({
        slot, pts, ...m, palm,
        tips: [4, 8, 12, 16, 20].map((k) => pts[k]),
        speed: this.speed(pts, slot, now),
      });
    });
    this.hands = out;
    // 超过 400ms 没出现的手，槽位作废
    for (let s = 0; s < 2; s++) if (now - this.slotsSeen[s] > 400) this.slotsSeen[s] = now;
    this.drawSkeleton();
    return out;
  }

  palmCenter(pts) {
    const ids = [0, 5, 9, 13, 17];
    const x = ids.reduce((a, k) => a + pts[k].x, 0) / ids.length;
    const y = ids.reduce((a, k) => a + pts[k].y, 0) / ids.length;
    return { x, y };
  }

  /* 手掌速度（归一化/秒），用来区分「慢慢靠近」和「快速划过」 */
  speed(pts, slot, now) {
    const c = this.palmCenter(pts);
    const s = this._prev || (this._prev = [{}, {}]);
    const p = s[slot];
    let v = 0;
    if (p.t) {
      const dt = Math.max(1, now - p.t) / 1000;
      v = Math.hypot(c.x - p.x, c.y - p.y) / dt;
    }
    s[slot] = { x: c.x, y: c.y, t: now };
    return v;
  }

  /* ---------- 手势标量（沿用原项目算法） ---------- */
  metrics(h, f, now) {
    const palm = dist(h[LM.wrist], h[LM.middleMCP]);
    // 两指开合：拇指尖到食指尖 ÷ 手掌长度（捏紧 ≈0.1，张开 ≈1.0）
    const ratio = dist(h[LM.thumbTip], h[LM.indexTip]) / (palm || 1e-6);
    const pinch = Math.max(0, Math.min(1, (ratio - 0.12) / 0.83));
    // 五指张开程度：拇指尖到小指尖的跨度
    const span = dist(h[LM.thumbTip], h[LM.pinkyTip]) / (palm || 1e-6);
    const spread = Math.max(0, Math.min(1, (span - 1.1) / 0.8));
    // 手掌倾斜角
    const roll = Math.atan2(h[LM.middleMCP].x - h[LM.wrist].x, h[LM.wrist].y - h[LM.middleMCP].y);
    // 数手指
    const ext = [
      dist(h[LM.thumbTip], h[LM.middleMCP]) > palm * 0.6,
      extended(h, 8, 6), extended(h, 12, 10), extended(h, 16, 14), extended(h, 20, 18),
    ];
    return {
      pinch: Math.max(0, Math.min(1, f.pinch(pinch, now))),
      spread: Math.max(0, Math.min(1, f.spread(spread, now))),
      roll: f.roll(roll, now),
      ext,
      count: ext.filter(Boolean).length,
    };
  }

  /* ---------- 骨架绘制（画在 overlay canvas 上） ---------- */
  drawSkeleton() {
    const cv = this.overlay;
    if (!cv) return;
    const g = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    if (!this.showPts) return;
    this.hands.forEach((h, i) => {
      const Pt = (p) => [(1 - p.x) * W, p.y * H]; // 镜像
      const col = i === 0 ? "255,176,120" : "150,215,205";
      g.lineWidth = Math.max(2, W / 220);
      g.strokeStyle = `rgba(${col},0.75)`;
      g.lineCap = "round";
      HAND_LINKS.forEach(([a, b]) => {
        g.beginPath(); g.moveTo(...Pt(h.pts[a])); g.lineTo(...Pt(h.pts[b])); g.stroke();
      });
      h.pts.forEach((p, k) => {
        const tip = [4, 8, 12, 16, 20].includes(k);
        g.fillStyle = tip ? `rgb(${col})` : "rgba(255,255,255,0.85)";
        g.beginPath(); g.arc(...Pt(p), W / (tip ? 150 : 240), 0, 7); g.fill();
      });
    });
  }
}
