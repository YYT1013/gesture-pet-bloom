/* ============================================================
 * bloom.js —— 「指尖开花」彩蛋模式
 *
 * 这段是从原项目搬过来的纯代码 3D 花：每片花瓣是三维空间里的弯曲曲面，
 * 捏合的开度决定花瓣和花茎的夹角，按观看角度投影到屏幕，
 * 再按远近排序一片片画。原项目的主线是开花，这里只留 3 种花做彩蛋。
 *
 * 触发：按 F 键，或在设置面板里点「开花彩蛋」。
 * 交互：手掌捏合/张开 → 花开/花合（复用同一套手部数据）。
 * ============================================================ */

const DEG = Math.PI / 180;
const SEG = 12;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

const P = (o) => Object.assign({
  n: 6, len: 0.4, wid: 0.15, p: 0.75, q: 0.8, notch: 0,
  t0: 8, t1: 70, curl: 0, cup: 0.3, ruffle: 0, delay: 0, twist: 0, base: 0.02,
  c0: "#ffffff", c1: "#dddddd",
}, o);

export const BLOOMS = [
  {
    name: "百合",
    view: 16,
    stem: { len: 1.3, bend: 0.1, w: 0.026, c: "#5f7f40" },
    layers: [
      P({ n: 3, len: 0.58, wid: 0.15, p: 0.58, q: 0.9, t0: 6, t1: 66, curl: 78, cup: 0.35, c0: "#fffaf3", c1: "#e4e8b4" }),
      P({ n: 3, len: 0.58, wid: 0.18, p: 0.58, q: 0.85, t0: 3, t1: 62, curl: 72, cup: 0.35, delay: 0.06, twist: 60, c0: "#fffdf8", c1: "#e8ecbd" }),
    ],
    center: { type: "stamens", n: 6, len: 0.46, spread: 20, fil: "#dfe6b2", anther: "#b9551d", pistil: "#cfe09a" },
  },
  {
    name: "荷",
    view: 24,
    stem: { len: 1.25, bend: 0.12, w: 0.028, c: "#55703a" },
    layers: [
      P({ n: 8, len: 0.5, wid: 0.19, p: 0.68, q: 0.9, t0: 9, t1: 80, curl: 12, cup: 0.5, c0: "#e27d98", c1: "#fdf1f3" }),
      P({ n: 8, len: 0.46, wid: 0.18, p: 0.68, q: 0.9, t0: 6, t1: 60, curl: 6, cup: 0.55, delay: 0.12, twist: 22.5, c0: "#e98aa3", c1: "#fff5f7" }),
      P({ n: 6, len: 0.38, wid: 0.16, p: 0.66, q: 0.9, t0: 3, t1: 36, cup: 0.6, delay: 0.24, twist: 10, c0: "#f09db2", c1: "#fff8f9" }),
    ],
    center: { type: "pod", r: 0.1, h: 0.1 },
  },
  {
    name: "樱",
    view: 72,
    stem: null,
    layers: [
      P({ n: 5, len: 0.42, wid: 0.27, p: 0.55, q: 0.55, notch: 0.12, t0: 10, t1: 84, cup: 0.22, c0: "#fde8ee", c1: "#f2a3ba" }),
    ],
    center: { type: "stamens", n: 24, len: 0.17, spread: 46, fil: "#f8d8df", anther: "#ecb245" },
  },
];

const hash = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

function camera(cx, cy, R, yaw, pitchDeg) {
  const pitch = pitchDeg * DEG;
  return { cx, cy, R, f: R * 5, cyw: Math.cos(yaw), syw: Math.sin(yaw), cp: Math.cos(pitch), sp: Math.sin(pitch) };
}
function proj(C, x, y, z) {
  const x1 = x * C.cyw + z * C.syw;
  const z1 = -x * C.syw + z * C.cyw;
  const y2 = y * C.cp - z1 * C.sp;
  const z2 = y * C.sp + z1 * C.cp;
  const k = C.f / (C.f - z2 * C.R);
  return [C.cx + x1 * C.R * k, C.cy - y2 * C.R * k, z2];
}
function rot(C, x, y, z) {
  const x1 = x * C.cyw + z * C.syw;
  const z1 = -x * C.syw + z * C.cyw;
  return [x1, y * C.cp - z1 * C.sp, y * C.sp + z1 * C.cp];
}
const LIGHT = (() => { const v = [-0.45, 0.7, 0.55]; const m = Math.hypot(...v); return v.map((x) => x / m); })();

function petal(C, o) {
  const { bx, by, bz, phi, theta, curl, L, W, p, q, notch, cup, ruffle, seed } = o;
  const rx = Math.cos(phi), rz = Math.sin(phi);
  const tx = -Math.sin(phi), tz = Math.cos(phi);
  const left = [], right = [], spine = [];
  let px = bx, py = by, pz = bz, nMid = null;
  for (let k = 0; k <= SEG; k++) {
    const u = k / SEG;
    const th = theta + curl * Math.pow(u, 1.6);
    const dx = Math.sin(th) * rx, dy = Math.cos(th), dz = Math.sin(th) * rz;
    if (k > 0) { px += dx * L / SEG; py += dy * L / SEG; pz += dz * L / SEG; }
    const nx = -Math.cos(th) * rx, ny = Math.sin(th), nz = -Math.cos(th) * rz;
    if (k === Math.round(SEG * 0.5)) nMid = [nx, ny, nz];
    const w = Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(u, p))), q) * W;
    const c = cup * w;
    const rf = ruffle ? Math.sin(u * 9 + seed * 6) * ruffle * W : 0;
    left.push(proj(C, px - tx * w + nx * (c + rf), py + ny * (c + rf), pz - tz * w + nz * (c + rf)));
    right.push(proj(C, px + tx * w + nx * (c - rf), py + ny * (c - rf), pz + tz * w + nz * (c - rf)));
    spine.push(proj(C, px, py, pz));
  }
  if (notch) {
    const back = spine[Math.round(SEG * (1 - notch))];
    left[SEG] = left[SEG - 1]; right[SEG] = right[SEG - 1];
    spine[SEG] = back;
  }
  const n = rot(C, ...nMid);
  const lit = Math.abs(n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
  const inner = n[2] > 0;
  let z = 0;
  for (const pt of spine) z += pt[2];
  return { left, right, spine, z: z / spine.length, lit, inner, tip: spine[SEG] };
}

function drawPetal(g, pt, c0, c1, scale) {
  g.beginPath();
  g.moveTo(pt.left[0][0], pt.left[0][1]);
  for (let k = 1; k < pt.left.length; k++) g.lineTo(pt.left[k][0], pt.left[k][1]);
  g.lineTo(pt.spine[pt.spine.length - 1][0], pt.spine[pt.spine.length - 1][1]);
  for (let k = pt.right.length - 1; k >= 0; k--) g.lineTo(pt.right[k][0], pt.right[k][1]);
  g.closePath();
  const a = pt.spine[0], b = pt.tip;
  const grad = g.createLinearGradient(a[0], a[1], b[0], b[1]);
  grad.addColorStop(0, c1);
  grad.addColorStop(1, c0);
  g.fillStyle = grad;
  g.fill();
  const dark = (pt.inner ? 0 : 0.1) + (1 - pt.lit) * 0.2;
  if (dark > 0.01) { g.fillStyle = `rgba(90,70,50,${dark})`; g.fill(); }
  g.strokeStyle = "rgba(150,120,90,0.28)";
  g.lineWidth = Math.max(0.6, scale * 0.002);
  g.stroke();
  // 中脉
  g.beginPath();
  g.moveTo(pt.spine[1][0], pt.spine[1][1]);
  for (let k = 2; k < pt.spine.length - 2; k++) g.lineTo(pt.spine[k][0], pt.spine[k][1]);
  g.strokeStyle = "rgba(160,120,120,0.16)";
  g.stroke();
}

const stemPoint = (st, t) => [st.bend * t * t, -st.len * 0.88 * t, 0];

/* 画一朵花：openness 0~1 决定开到什么程度 */
export function drawBloom(g, W, H, type, openness, yaw) {
  const f = BLOOMS[type % BLOOMS.length];
  const R = Math.min(W * 0.40, H * 0.40);
  const cx = W / 2;
  const cy = H * (f.stem ? 0.58 : 0.5);
  const C = camera(cx, cy, R, yaw, f.view);
  const items = [];

  if (f.stem) {
    const st = f.stem;
    const pts = [];
    for (let k = 0; k <= 16; k++) pts.push(proj(C, ...stemPoint(st, k / 16)));
    items.push({
      z: -9, draw() {
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (const p of pts) g.lineTo(p[0], p[1]);
        g.strokeStyle = st.c;
        g.lineCap = "round";
        g.lineWidth = st.w * R;
        g.stroke();
      },
    });
  }

  f.layers.forEach((ly) => {
    const s = smooth(clamp((openness - ly.delay) / (1 - ly.delay)));
    const theta = lerp(ly.t0, ly.t1, s);
    const curl = ly.curl * s;
    for (let i = 0; i < ly.n; i++) {
      const seed = i * 7 + 3;
      const j = hash(seed) - 0.5;
      const phi = (i / ly.n) * 360 + ly.twist + j * 10 + (1 - s) * 18;
      const pt = petal(C, {
        bx: Math.cos(phi * DEG) * ly.base, by: 0, bz: Math.sin(phi * DEG) * ly.base,
        phi: phi * DEG, theta: (theta + j * 6) * DEG, curl: curl * DEG,
        L: ly.len * (0.78 + 0.22 * s) * (1 + j * 0.1),
        W: ly.wid * (0.75 + 0.25 * s),
        p: ly.p, q: ly.q, notch: ly.notch, cup: ly.cup * (1.2 - 0.4 * s), ruffle: ly.ruffle * s, seed,
      });
      items.push({ z: pt.z, draw: () => drawPetal(g, pt, ly.c0, ly.c1, R) });
    }
  });

  // 花心
  const cen = f.center;
  const cv = smooth(clamp((openness - 0.4) / 0.6));
  if (cen && cv > 0) {
    if (cen.type === "stamens") {
      const lines = [];
      for (let k = 0; k < cen.n; k++) {
        const a = (k / cen.n) * Math.PI * 2 + hash(k + 7) * 0.4;
        const tilt = (cen.spread + hash(k) * 10) * DEG * cv;
        const len = cen.len * (0.85 + 0.3 * hash(k + 3)) * (0.5 + 0.5 * cv);
        const end = [Math.sin(tilt) * Math.cos(a) * len, Math.cos(tilt) * len, Math.sin(tilt) * Math.sin(a) * len];
        lines.push([proj(C, 0, 0, 0), proj(C, end[0] * 0.5, end[1] * 0.55, end[2] * 0.5), proj(C, ...end)]);
      }
      items.push({
        z: proj(C, 0, cen.len * 0.5, 0)[2], draw() {
          g.globalAlpha = cv;
          g.lineCap = "round";
          for (const [a, m, e] of lines) {
            g.strokeStyle = cen.fil; g.lineWidth = Math.max(1, R * 0.004);
            g.beginPath(); g.moveTo(a[0], a[1]); g.quadraticCurveTo(m[0], m[1], e[0], e[1]); g.stroke();
            g.fillStyle = cen.anther;
            g.beginPath(); g.ellipse(e[0], e[1], R * 0.012, R * 0.007, 0.6, 0, 7); g.fill();
          }
          g.globalAlpha = 1;
        },
      });
    } else {
      const ring = [];
      for (let k = 0; k < 28; k++) {
        const a = (k / 28) * Math.PI * 2;
        ring.push(proj(C, Math.cos(a) * cen.r, cen.h * cv, Math.sin(a) * cen.r));
      }
      const mid = proj(C, 0, cen.h * cv, 0);
      items.push({
        z: mid[2] + 0.02, draw() {
          g.globalAlpha = cv;
          g.beginPath();
          ring.forEach((p, k) => (k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
          g.closePath();
          const rg = g.createRadialGradient(mid[0], mid[1], 0, mid[0], mid[1], cen.r * R);
          rg.addColorStop(0, "#dfe08a"); rg.addColorStop(1, "#a9b04e");
          g.fillStyle = rg; g.fill();
          g.globalAlpha = 1;
        },
      });
    }
  }

  items.sort((a, b) => a.z - b.z);
  for (const it of items) it.draw();
}
