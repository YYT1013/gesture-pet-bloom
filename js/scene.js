/* ============================================================
 * scene.js —— 真实居家桌面实景（背景 + 光影统一）
 *
 * 设计要点（对应需求「真实场景 + 光影同源」）：
 *   1. 底图是实拍质感的居家桌面照片，不是渐变、不是插画；
 *      横屏 / 竖屏各一张，按容器比例自动挑一张并按 cover 裁切。
 *   2. 背景在 resize 时**一次性合成**进离屏 canvas（缩放 + 调色 + 底部压暗），
 *      每帧只贴一次图，不重复做图像运算。
 *   3. 每帧最后再盖一层「光」：左上暖光 + 右下冷补光 + 暗角。
 *      这一层盖在「场景 + 宠物 + 影子」之上，所以三者是同一束光，
 *      不会出现宠物比背景亮/暗这种贴纸感。
 *
 * 参考：
 *   · canvasengine / SpriteShadows —— 剪影投影 + 接触阴影 + 半影渐隐的 2D 落地阴影做法
 *   · SkywardSyntax/LightingEngine —— 环境光遮蔽（AO）与径向光衰减的 Canvas 实现
 * ============================================================ */

import { asDirectoryUrl } from "./asset-url.js";

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const DEFAULT_SCENE_BASE = asDirectoryUrl(new URL("../assets/scene/", import.meta.url).href);

export const SCENE = {
  /* 光源在画面里的位置（左上角窗户方向），影子朝右下投 */
  light: { x: 0.17, y: 0.09 },
  /* 宠物脚底的落地点（占画面高度） */
  groundY: 0.90,
  ready: false,
  /* 场景本身的平均色，用于给 UI/加载态取色 */
  tone: "#8a6a48",
};

const IMGS = { land: null, port: null };

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.decoding = "async";
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("场景图加载失败：" + src));
    im.src = src;
  });
}

/** 加载横竖两张底图（共约 300 KB）
 *  默认路径按「模块自身位置」算，不是按页面位置算 ——
 *  这样页面放在子目录（比如 tools/ 下的自检页）也不会 404。 */
export async function loadScene(base = DEFAULT_SCENE_BASE) {
  try {
    const [land, port] = await Promise.all([
      loadImage(base + "desk-land.webp"),
      loadImage(base + "desk-port.webp"),
    ]);
    IMGS.land = land;
    IMGS.port = port;
    SCENE.ready = true;
  } catch (e) {
    console.warn("[scene]", e);
    SCENE.ready = false;
  }
  return SCENE.ready;
}

/**
 * 把场景合成为一张离屏图（resize 时调一次）。
 * @returns {HTMLCanvasElement} 可以直接 drawImage 的背景
 */
export function buildBackdrop(w, h, dpr) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const b = c.getContext("2d");
  b.setTransform(dpr, 0, 0, dpr, 0, 0);

  const img = w / h > 1.08 ? IMGS.land : IMGS.port;

  if (!img) {
    /* 兜底：场景图没加载出来也不能白屏，用暖色底 */
    const lin = b.createLinearGradient(0, 0, 0, h);
    lin.addColorStop(0, "#efe3d2");
    lin.addColorStop(0.55, "#e6d5bf");
    lin.addColorStop(1, "#c9ab84");
    b.fillStyle = lin;
    b.fillRect(0, 0, w, h);
    return c;
  }

  /* cover 裁切：等比放大到铺满，水平居中，垂直略偏下（让桌面多露一点） */
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s, dh = img.height * s;
  const dx = (w - dw) / 2;
  const dy = (h - dh) * 0.5 + dh * 0.02;

  b.drawImage(img, dx, dy, dw, dh);

  /* 轻微降饱和 + 提暖：照片直出会偏艳，压一点才像「家居自然光」 */
  b.save();
  b.globalCompositeOperation = "soft-light";
  const warm = b.createLinearGradient(0, 0, w * 0.9, h);
  warm.addColorStop(0, "rgba(255,224,178,0.55)");
  warm.addColorStop(0.45, "rgba(255,232,200,0.20)");
  warm.addColorStop(1, "rgba(120,132,160,0.22)");
  b.fillStyle = warm;
  b.fillRect(0, 0, w, h);
  b.restore();

  /* 远处虚化：越靠上越淡，把「背景」和「桌面」的层次拉开 */
  const depth = b.createLinearGradient(0, 0, 0, h * 0.72);
  depth.addColorStop(0, "rgba(247,240,230,0.42)");
  depth.addColorStop(0.55, "rgba(247,240,230,0.10)");
  depth.addColorStop(1, "rgba(247,240,230,0)");
  b.fillStyle = depth;
  b.fillRect(0, 0, w, h * 0.72);

  /* 桌面近处压暗一点，给宠物脚底留出「接地」的深色空间 */
  const floor = b.createLinearGradient(0, h * SCENE.groundY - h * 0.06, 0, h);
  floor.addColorStop(0, "rgba(60,38,20,0)");
  floor.addColorStop(1, "rgba(52,31,16,0.26)");
  b.fillStyle = floor;
  b.fillRect(0, h * SCENE.groundY - h * 0.06, w, h * (1 - SCENE.groundY) + h * 0.06);

  return c;
}

/* ---------------- 每帧的光影层 ----------------
 * 放在「场景 + 宠物 + 影子」画完之后：三者一起吃同一束光。 */
let lightCache = null;
function ensureLight(w, h) {
  if (lightCache && lightCache.w === w && lightCache.h === h) return lightCache;

  const sun = { x: w * SCENE.light.x, y: h * SCENE.light.y };
  const R = Math.max(w, h) * 0.95;

  const warm = [
    [0, "rgba(255,238,205,0.55)"],
    [0.42, "rgba(255,231,196,0.16)"],
    [1, "rgba(255,226,190,0)"],
  ];
  const cool = [
    [0, "rgba(150,168,200,0.20)"],
    [0.55, "rgba(150,168,200,0.07)"],
    [1, "rgba(150,168,200,0)"],
  ];
  const vig = [
    [0, "rgba(40,24,12,0)"],
    [0.62, "rgba(40,24,12,0.04)"],
    [1, "rgba(34,20,10,0.30)"],
  ];

  const mk = (stops, r, cx, cy) => {
    // 交点用「单位圆」定义，实际画的时候再按画布尺寸建渐变（见 drawLightPass）
    return { stops, r, cx, cy };
  };

  lightCache = {
    w, h, sun, R,
    warm: mk(warm, R, sun.x, sun.y),
    cool: mk(cool, R * 1.15, w * 0.92, h * 0.94),
    vig: mk(vig, Math.hypot(w, h) * 0.62, w * 0.5, h * 0.46),
    grad: { warm: null, cool: null, vig: null },
  };
  return lightCache;
}

export function drawLightPass(g, w, h) {
  const L = ensureLight(w, h);

  /* 渐变对象按画布尺寸缓存，避免每帧新建 */
  if (!L.grad.warm) {
    const mkGrad = (spec, radius) => {
      const gr = g.createRadialGradient(spec.cx, spec.cy, 0, spec.cx, spec.cy, radius);
      spec.stops.forEach(([p, c]) => gr.addColorStop(p, c));
      return gr;
    };
    L.grad.warm = mkGrad(L.warm, L.warm.r);
    L.grad.cool = mkGrad(L.cool, L.cool.r);
    L.grad.vig = mkGrad(L.vig, L.vig.r);
  }

  g.save();
  g.globalCompositeOperation = "soft-light";
  g.fillStyle = L.grad.warm;
  g.fillRect(0, 0, w, h);
  g.fillStyle = L.grad.cool;
  g.fillRect(0, 0, w, h);
  g.restore();

  /* 暗角用普通 alpha 叠，别让它参与 soft-light 的对比度运算 */
  g.save();
  g.fillStyle = L.grad.vig;
  g.fillRect(0, 0, w, h);
  g.restore();
}

/** 桌面上那圈被窗光打亮的高光（宠物身前），很淡，只为把「同一束光」说圆 */
export function drawLightSpill(g, w, h, cx, groundY, r) {
  const gr = g.createRadialGradient(cx, groundY, 0, cx, groundY, r);
  gr.addColorStop(0, "rgba(255,232,192,0.20)");
  gr.addColorStop(0.6, "rgba(255,232,192,0.07)");
  gr.addColorStop(1, "rgba(255,232,192,0)");
  g.save();
  g.globalCompositeOperation = "screen";
  g.fillStyle = gr;
  g.beginPath();
  g.ellipse(cx, groundY, r, r * 0.42, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

export const sceneReady = () => SCENE.ready;
export const clampScene = clamp;
