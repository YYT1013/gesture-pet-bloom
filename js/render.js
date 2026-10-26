/* ============================================================
 * render.js —— 照片木偶渲染器（实景融合版）
 *
 * 素材是实拍照片抠出来的几层 webp：
 *   <id>.webp        整只（身体底图，颈线以下那部分本来就是原照片像素）
 *   <id>_head.webp   颈部以上（下缘羽化，枢轴在颈部）
 *   <id>_pawL/R.webp 前爪补丁（跑动时交替抬起，叠在身体上面不露洞）
 * 用户上传的复刻宠物只有 full + head 两层（单张照片拆不出独立四肢）。
 *
 * 三个让「照片」不像「贴纸」的处理：
 *   1. relight()  按场景光向给每层调色：左上暖、右下冷、脚边压暗。
 *                  调色在加载时做一次并缓存，每帧零成本。
 *   2. 落地投影    用宠物自己的剪影压扁 + 虚化，朝光源反方向投；
 *                  再叠一块更实的接触阴影 —— 这是「站得住」的关键。
 *   3. 毛发微动    头部叠加两条不同频率的正弦位移（亚像素级），
 *                  静态时也有极轻微的呼吸/毛发浮动，不是一张死图。
 *
 * 坐标系（pet 本地，1.0 = 宠物显示高度，原点在脚下地面）：
 *   渲染里先 scale(k)（k = 显示高度 / 素材高度），之后一律用素材像素，
 *   所以 touch.js 用 pet.S = 显示高度换算出来的本地坐标能直接对上。
 * ============================================================ */

import { SCENE } from "./scene.js";

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

/* 宠物在桌上的坐高 / 最宽 / 脚底落点 */
export const RIG = { maxH: 0.68, maxW: 0.74, groundY: SCENE.groundY };

/* canvas filter 支持性（Safari 16 以前没有，降级成多层堆叠画） */
let canFilter = (() => {
  try {
    const c = document.createElement("canvas").getContext("2d");
    c.filter = "blur(2px)";
    return c.filter === "blur(2px)";
  } catch { return false; }
})();

/* ---------------- 素材 ---------------- */
const ASSETS = new Map();   // id -> { full, head, pawL, pawR, sil, meta }
let META = null;

/* 素材根目录：按模块自身位置算（js/render.js → 项目根），
   这样页面放在子目录里也不会把 ./assets 解析到错的地方 */
const ROOT = new URL("../", import.meta.url).href;

function loadImg(url) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.decoding = "async";
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("素材加载失败: " + (url || "").slice(0, 60)));
    im.src = url;
  });
}

/** 按场景光向调色：左上暖光、右下冷补光、脚边压暗。加载时做一次。 */
function relight(img) {
  const w = img.width, h = img.height;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);

  g.globalCompositeOperation = "source-atop";     // 只作用在宠物像素上

  const lin = g.createLinearGradient(0, 0, w, h);
  lin.addColorStop(0, "rgba(255,224,176,0.17)");
  lin.addColorStop(0.48, "rgba(255,242,218,0.03)");
  lin.addColorStop(1, "rgba(92,112,148,0.17)");
  g.fillStyle = lin;
  g.fillRect(0, 0, w, h);

  /* 脚边环境光遮蔽：下半身压暗，避免「浮在桌上」 */
  const ao = g.createLinearGradient(0, h * 0.74, 0, h);
  ao.addColorStop(0, "rgba(44,26,12,0)");
  ao.addColorStop(1, "rgba(44,26,12,0.30)");
  g.fillStyle = ao;
  g.fillRect(0, h * 0.74, w, h * 0.26);

  /* 头顶一点高光（窗光从左上打下来） */
  const hi = g.createRadialGradient(w * 0.34, h * 0.12, 0, w * 0.34, h * 0.12, w * 0.55);
  hi.addColorStop(0, "rgba(255,246,228,0.22)");
  hi.addColorStop(1, "rgba(255,246,228,0)");
  g.fillStyle = hi;
  g.fillRect(0, 0, w, h);

  return c;
}

/** 剪影（投影用）：一次生成，每帧只做一次带缩放的 drawImage */
function silhouette(img, targetH = 120) {
  const s = targetH / img.height;
  const bw = Math.max(8, Math.round(img.width * s));
  const c = document.createElement("canvas");
  c.width = bw; c.height = targetH;
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, bw, targetH);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = "#1b1109";
  g.fillRect(0, 0, bw, targetH);
  return c;
}

function register(cfg, fullImg, headImg, pawL, pawR, meta) {
  /* 几何以素材为准：宽高比和颈线直接由 meta 回写进配置。
     换照片重跑 build_pets.py 之后不必再手动改 config.js，
     触摸分区、布局缩放也不会和数据脱节。 */
  if (meta && meta.full) {
    cfg.aspect = meta.full.w / meta.full.h;
    cfg.neckY = meta.neckY;
  }
  ASSETS.set(cfg.id, {
    full: relight(fullImg),
    head: relight(headImg),
    pawL: pawL ? relight(pawL) : null,
    pawR: pawR ? relight(pawR) : null,
    sil: silhouette(fullImg),
    meta,
  });
}

/**
 * 加载素材。
 * 内置 7 只从 assets/pets/ 读；用户复刻的宠物直接带 base64 图层 + 几何。
 */
export async function loadAssets(pets, onProgress) {
  if (!META) {
    const r = await fetch(new URL("assets/pets/meta.json", ROOT), { cache: "force-cache" });
    if (!r.ok) throw new Error("读不到 assets/pets/meta.json");
    META = await r.json();
  }
  let done = 0;
  const total = pets.length;
  await Promise.all(pets.map(async (cfg) => {
    try {
      if (cfg.custom) {
        if (ASSETS.has(cfg.id)) return;
        const [full, head] = await Promise.all([loadImg(cfg.imgFull), loadImg(cfg.imgHead)]);
        register(cfg, full, head, null, null, cfg.meta);
        return;
      }
      if (ASSETS.has(cfg.id)) return;
      const base = new URL(`assets/pets/${cfg.id}`, ROOT).href;
      const meta = META[cfg.id];
      if (!meta) { console.warn("[render] 缺素材几何:", cfg.id); return; }
      const [full, head] = await Promise.all([
        loadImg(`${base}.webp`), loadImg(`${base}_head.webp`),
      ]);
      const hasPaws = meta.paws && meta.paws.L && meta.paws.R;
      const [pawL, pawR] = hasPaws
        ? await Promise.all([loadImg(`${base}_pawL.webp`), loadImg(`${base}_pawR.webp`)])
        : [null, null];
      register(cfg, full, head, pawL, pawR, meta);
    } finally {
      done++;
      onProgress && onProgress(done / total);
    }
  }));
  return ASSETS.size;
}

export const assetReady = (id) => ASSETS.has(id);

/* ---------------- 布局 ----------------
 * 每帧算一次：宠物多大、站在哪儿。同时写回 pet，供触摸判定使用。 */
export function layout(pet, W, H) {
  const A = ASSETS.get(pet.cfg.id);
  const aspect = pet.cfg.aspect || 0.6;
  const byH = H * RIG.maxH;
  const byW = (W * RIG.maxW) / aspect;
  const dispH = Math.min(byH, byW) * (pet.cfg.size || 1);

  pet.dispH = dispH;
  pet.k = A ? dispH / A.meta.full.h : 1;   // 素材像素 → 屏幕像素
  pet.S = dispH;                            // 触摸层用：1.0 = 显示高度
  pet.cx = W * 0.5;
  pet.cy = H * RIG.groundY;
  pet.W = W; pet.H = H;                 // 动作幅度要用画布尺寸做上限
  return pet;
}

/* ---------------- 落地投影 ----------------
 * 必须在画宠物之前调用。思路同 SpriteShadows：
 * 剪影压扁 → 朝光源反方向偏移 → 虚化成半影；脚底再补一块更实的接触阴影。 */
export function drawPetShadow(g, pet) {
  const A = ASSETS.get(pet.cfg.id);
  if (!A || !A.sil) return;

  const p = pet.pose;
  const H0 = pet.dispH;
  const liftN = clamp(Math.max(0, -p.y) / (H0 * 0.55));   // 抬得越高影子越淡越小
  const sx = Math.abs(p.sx || 1);

  const bx = pet.cx + p.x * 1.02 + H0 * 0.055 * (1 - liftN);   // 光在左上 → 影子偏右下
  const by = pet.cy + H0 * 0.004;

  const w = H0 * 0.78 * (0.55 + 0.45 * sx) * (1 - liftN * 0.22);
  const h = H0 * 0.17 * (1 - liftN * 0.45);

  g.save();
  if (canFilter) g.filter = `blur(${(H0 * 0.030).toFixed(1)}px)`;
  g.globalAlpha = 0.32 * (1 - liftN * 0.62);
  g.drawImage(A.sil, bx - w / 2, by - h * 0.60, w, h);
  g.restore();

  /* 接触阴影：贴地那一小块，最实，负责「站得住」 */
  g.save();
  if (canFilter) g.filter = `blur(${(H0 * 0.012).toFixed(1)}px)`;
  g.globalAlpha = 0.28 * (1 - liftN * 0.8);
  g.fillStyle = "#20130a";
  g.beginPath();
  g.ellipse(pet.cx + p.x, by, H0 * 0.26 * sx, H0 * 0.030, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/* ---------------- 主绘制 ---------------- */
export function drawPet(g, pet, W, H, now) {
  const A = ASSETS.get(pet.cfg.id);
  if (!A) return;
  layout(pet, W, H);

  const m = A.meta;
  const p = pet.pose;
  const k = pet.k;

  g.save();
  g.translate(pet.cx + p.x, pet.cy + p.y);
  g.scale(k, k);
  if (p.rot) {
    /* 旋转轴心放在身体中段（不是脚底）：
       绕脚底转 180° 会把整只甩到地面线以下、直接看不见，
       绕中点转才能「原地翻一圈」，上下边界始终落在 -H..0 之间 */
    const pv = pet.dispH * 0.46;
    g.translate(0, -pv);
    g.rotate(p.rot);
    g.translate(0, pv);
  }
  if (p.sx !== 1 || p.sy !== 1) g.scale(p.sx, p.sy);

  /* 横向原点 = 图片中心（meta 里的 ox 已经是「相对底边中心」的量），
     所以这里必须是 0，不能再加一次半宽 —— 加了头就会整体右移半只 */
  const cxA = 0;
  const HU = m.full.h;                 // 素材像素高：pose 里的比例量都乘它
  /* 颈部枢轴：meta 里的 neckY 是「从顶部往下」的比例，
     而这里的 y=0 在脚下（地面），所以必须减一个素材高度换算过来 */
  const neck = (m.neckY - 1) * HU;

  /* 身体（整张原图打底：颈下是原照片像素，头和身体没有接缝） */
  g.drawImage(A.full, m.body.ox, m.body.oy, m.body.w, m.body.h);

  /* 前爪：交替抬起（补丁叠在身体上，不会露洞）。复刻宠物没有这一层 */
  if (A.pawL && (p.pawL || p.pawR)) {
    g.drawImage(A.pawL, m.paws.L.ox, m.paws.L.oy + p.pawL * HU, m.paws.L.w, m.paws.L.h);
    g.drawImage(A.pawR, m.paws.R.ox, m.paws.R.oy + p.pawR * HU, m.paws.R.w, m.paws.R.h);
  }

  /* 头：以颈部为枢轴转。叠加两条低频正弦做「毛发微动」，
     幅度是素材像素级的零点几像素，静态看着不动、动起来有活气。 */
  const micro = Math.sin(now * 0.0016) * 0.32 + Math.sin(now * 0.00073 + 1.7) * 0.22;
  g.save();
  g.translate(cxA + p.headDX * HU + micro * 0.7, neck + p.headDY * HU + micro);
  g.rotate(p.headRot);
  g.drawImage(A.head, -m.head.px, -m.head.py, m.head.w, m.head.h);
  g.restore();

  g.restore();
}

/* ---------------- 情绪特效 ---------------- */
export function drawMood(g, pet, W, H, now) {
  /* 舒服时飘小爱心（照片宠物没法做表情，用这个补情绪） */
  if (pet.mood > 0.62 && pet.state !== "idle") {
    const n = 3;
    for (let i = 0; i < n; i++) {
      const t = ((now / 1000) * 0.34 + i / n) % 1;
      const x = pet.cx + Math.sin(t * 6 + i * 2) * W * 0.04 + (i - 1) * W * 0.030;
      const y = pet.cy - pet.dispH * 0.95 - t * H * 0.12;
      const s = pet.dispH * 0.028;
      g.save();
      g.globalAlpha = Math.sin(t * Math.PI) * 0.42 * Math.min(1, (pet.mood - 0.6) * 3.2);
      g.fillStyle = "#f0879a";
      g.beginPath();
      g.moveTo(x, y + s * 0.6);
      g.bezierCurveTo(x - s * 1.4, y - s * 0.5, x - s * 0.3, y - s * 1.4, x, y - s * 0.35);
      g.bezierCurveTo(x + s * 0.3, y - s * 1.4, x + s * 1.4, y - s * 0.5, x, y + s * 0.6);
      g.fill();
      g.restore();
    }
  }
  /* 跑动 / 打滚时的小尘埃，贴着桌面飞 */
  if (pet.dust > 0.02) {
    g.save();
    g.globalAlpha = pet.dust * 0.42;
    g.fillStyle = "#d8c3a4";
    for (let i = 0; i < 5; i++) {
      const dir = i % 2 ? 1 : -1;
      const t = ((now / 900) + i * 0.21) % 1;
      const x = pet.cx + dir * (pet.dispH * (0.18 + t * 0.30));
      const y = pet.cy - pet.dispH * (0.02 + t * 0.05);
      g.beginPath();
      g.arc(x, y, pet.dispH * (0.010 + t * 0.018), 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }
}
