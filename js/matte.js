/* ============================================================
 * matte.js —— 上传照片 → 本地抠图 → 生成「照片木偶」四层素材
 *
 * 全程在浏览器本机跑：图片不进网络、不落盘，只在内存里过一遍。
 *
 * 抠图分两路，取效果好的那一路：
 *   A. DeepLab V3（MediaPipe ImageSegmenter，Pascal VOC 21 类）
 *      —— cat / dog 类专门训过，猫狗照片的边缘（尤其毛）明显更准。
 *   B. GrabCut-lite（纯 JS，颜色直方图 + 迭代图割近似）
 *      —— 仓鼠、兔子、异宠这类 VOC 里没有的动物自动走这条路；
 *         也是 A 失败（模型没加载出来）时的兜底。
 *
 * 两路输出都过同一套后处理：
 *   阈值迟滞 → 最大连通域 → 补洞 → 边缘羽化 → 边缘去色污染（去白边）
 * 再按颈部切线切成「整图 / 头」两层，并算出 render.js 要的几何参数。
 *
 * 参考：
 *   · Vikhas/pet-segmentation —— 宠物抠图，用 Laplacian 金字塔损失保毛发高频细节，
 *     提示我们必须保留软 alpha 边缘，不能二值化硬切
 *   · mathofdynamic/remove-bg-grapcut —— OpenCV.js 在浏览器里跑 GrabCut 的完整流程
 *   · sunmoonstrand/removebg —— 多算法并存的策略（AI 模式 + GrabCut 模式 + 手动修正）
 *   · Rother et al., "GrabCut": interactive foreground extraction (SIGGRAPH 2004)
 * ============================================================ */

import { FilesetResolver, ImageSegmenter } from "../lib/vision_bundle.mjs";
import { asDirectoryUrl } from "./asset-url.js";

const WASM_BASE = asDirectoryUrl(new URL("../lib/wasm", import.meta.url).href);

/* DeepLab V3 / Pascal VOC 类别下标 */
const CLS = { bg: 0, cat: 8, dog: 12 };

let segmenter = null;
let segLoading = null;

/** 懒加载分割模型（2.65 MB，只有第一次点「生成」才会去拉） */
export async function loadSegmenter(onMsg) {
  if (segmenter) return segmenter;
  if (segLoading) return segLoading;

  segLoading = (async () => {
    onMsg && onMsg("正在准备抠图模型…");
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    const make = (delegate) =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: new URL("../models/pet_segmenter.tflite", import.meta.url).href, delegate },
        runningMode: "IMAGE",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    try {
      segmenter = await make("GPU");
    } catch (e) {
      console.warn("[matte] GPU 委托失败，回退 CPU", e);
      segmenter = await make("CPU");
    }
    return segmenter;
  })();

  return segLoading;
}

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

/* ---------------- A. DeepLab 分割 ---------------- */
export async function segmentDeepLab(source, w, h) {
  const s = await loadSegmenter();
  const res = s.segment(source);
  const masks = res.confidenceMasks;
  if (!masks || !masks.length) { res.close && res.close(); return null; }

  const mw = masks[0].width, mh = masks[0].height;
  /* 宠物类：猫 ∪ 狗。逐像素取两者的较大值，避免「猫被认成狗」时半个身子没了 */
  const cat = masks[CLS.cat] ? masks[CLS.cat].getAsFloat32Array() : null;
  const dog = masks[CLS.dog] ? masks[CLS.dog].getAsFloat32Array() : null;

  let a = new Float32Array(mw * mh);
  if (cat || dog) {
    for (let i = 0; i < a.length; i++) {
      a[i] = Math.max(cat ? cat[i] : 0, dog ? dog[i] : 0);
    }
  }

  /* 宠物类几乎没命中（仓鼠/兔子/异宠）→ 换策略：
     取「所有非背景类」里面积最大、且重心靠中间的那一类 */
  let area = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > 0.5) area++;
  if (area / a.length < 0.012) {
    let best = null, bestArea = 0;
    for (let k = 1; k < masks.length; k++) {
      const m = masks[k].getAsFloat32Array();
      let cnt = 0, sx = 0, sy = 0;
      for (let i = 0; i < m.length; i++) {
        if (m[i] > 0.5) { cnt++; sx += i % mw; sy += (i / mw) | 0; }
      }
      if (!cnt) continue;
      const cx = sx / cnt / mw, cy = sy / cnt / mh;
      /* 重心要偏中间：宠物一般就在画面中央，沙发/桌子贴边 */
      if (cx < 0.22 || cx > 0.78 || cy < 0.18 || cy > 0.92) continue;
      const score = cnt * (1 - Math.abs(cx - 0.5));
      if (score > bestArea) { bestArea = score; best = m; }
    }
    if (best) a = best;
  }

  res.close && res.close();

  /* 上采样到工作尺寸（用 canvas 双线性，比手写快得多） */
  return upsample(a, mw, mh, w, h);
}

function upsample(a, mw, mh, w, h) {
  const c = document.createElement("canvas");
  c.width = mw; c.height = mh;
  const g = c.getContext("2d");
  const id = g.createImageData(mw, mh);
  for (let i = 0; i < a.length; i++) {
    const v = Math.round(clamp(a[i]) * 255);
    id.data[i * 4] = v;
    id.data[i * 4 + 3] = 255;
  }
  g.putImageData(id, 0, 0);

  const d = document.createElement("canvas");
  d.width = w; d.height = h;
  const dg = d.getContext("2d");
  dg.imageSmoothingEnabled = true;
  dg.imageSmoothingQuality = "high";
  dg.drawImage(c, 0, 0, w, h);
  const out = dg.getImageData(0, 0, w, h).data;
  const res = new Float32Array(w * h);
  for (let i = 0; i < res.length; i++) res[i] = out[i * 4] / 255;
  return res;
}

/* ---------------- B. GrabCut-lite（纯 JS 兜底） ---------------- */
export function grabcutLite(data, w, h) {
  const n = w * h;
  const BINS = 12, Q = 256 / BINS;
  const hist = () => new Float32Array(BINS * BINS * BINS);
  const idx = (r, g, b) => ((r / Q) | 0) * BINS * BINS + ((g / Q) | 0) * BINS + ((b / Q) | 0);

  const hf = hist(), hb = hist();
  const seedF = new Uint8Array(n), seedB = new Uint8Array(n);

  const band = Math.round(Math.min(w, h) * 0.10);
  const cx0 = w * 0.5, cy0 = h * 0.55;
  const rx = w * 0.34, ry = h * 0.42;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = i * 4;
      const r = data[o], gg = data[o + 1], b = data[o + 2];
      const onBorder = x < band || y < band || x >= w - band || y >= h - band;
      const k = idx(r, gg, b);
      if (onBorder) { seedB[i] = 1; hb[k] += 1; continue; }
      const nx = (x - cx0) / rx, ny = (y - cy0) / ry;
      if (nx * nx + ny * ny < 1) { seedF[i] = 1; hf[k] += 1; }
    }
  }
  /* 直方图平滑 + 拉普拉斯极小平滑，避免零概率 */
  const smooth = (hh) => {
    const o = new Float32Array(hh.length);
    for (let i = 0; i < hh.length; i++) o[i] = hh[i] + 0.5;
    return o;
  };

  const alpha = new Float32Array(n);
  let llr = new Float32Array(n);

  for (let iter = 0; iter < 3; iter++) {
    const F = smooth(hf), B = smooth(hb);
    let sf = 0, sb = 0;
    for (let i = 0; i < F.length; i++) { sf += F[i]; sb += B[i]; }
    const lf = new Float32Array(F.length), lb = new Float32Array(B.length);
    for (let i = 0; i < F.length; i++) { lf[i] = Math.log(F[i] / sf); lb[i] = Math.log(B[i] / sb); }

    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const k = idx(data[o], data[o + 1], data[o + 2]);
      llr[i] = lf[k] - lb[k];
    }

    /* 3x3 均值平滑两遍：等价于给「图割」加一个空间平滑项，抑制胡椒噪点 */
    llr = boxBlur(llr, w, h, 1);
    llr = boxBlur(llr, w, h, 1);

    /* 用当前结果重建颜色模型（种子像素永远保留，防止模型退化） */
    const nf = hist(), nb = hist();
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const k = idx(data[o], data[o + 1], data[o + 2]);
      if (seedF[i] || (!seedB[i] && llr[i] > 0)) nf[k] += 1;
      else nb[k] += 1;
    }
    hf.set(nf); hb.set(nb);
  }

  /* 软 alpha：LLR 过 smoothstep，边界保留过渡带（毛发需要） */
  for (let i = 0; i < n; i++) {
    if (seedF[i]) alpha[i] = 1;
    else if (seedB[i]) alpha[i] = 0;
    else alpha[i] = clamp((llr[i] + 0.9) / 1.8);
  }
  return alpha;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[y * w + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / win;
      sum += src[y * w + clamp(x + r + 1, 0, w - 1)] - src[y * w + clamp(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}

/* ---------------- 后处理：迟滞 + 连通域 + 补洞 + 羽化 ---------------- */
export function refine(alpha, w, h, opts) {
  const n = w * h;
  const HI = (opts && opts.HI) || 0.55, LO = (opts && opts.LO) || 0.22;

  /* 1. 迟滞：强边缘做种子，弱边缘只要连着强边缘就保留 */
  const lab = new Uint8Array(n);           // 0 未知 1 前景 2 背景
  for (let i = 0; i < n; i++) lab[i] = alpha[i] >= HI ? 1 : alpha[i] <= LO ? 2 : 0;
  const q = [];
  for (let i = 0; i < n; i++) if (lab[i] === 1) q.push(i);
  while (q.length) {
    const i = q.pop();
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (lab[j] === 0) { lab[j] = 1; q.push(j); }
      }
    }
  }
  for (let i = 0; i < n; i++) if (lab[i] === 0) lab[i] = 2;

  /* 2. 最大连通域：去掉背景里误判的碎块（花瓶、抱枕花纹） */
  const seen = new Uint8Array(n);
  let best = null, bestSize = 0;
  for (let i = 0; i < n; i++) {
    if (lab[i] !== 1 || seen[i]) continue;
    const comp = [];
    const st = [i]; seen[i] = 1;
    while (st.length) {
      const j = st.pop(); comp.push(j);
      const x = j % w, y = (j / w) | 0;
      if (x > 0 && lab[j - 1] === 1 && !seen[j - 1]) { seen[j - 1] = 1; st.push(j - 1); }
      if (x < w - 1 && lab[j + 1] === 1 && !seen[j + 1]) { seen[j + 1] = 1; st.push(j + 1); }
      if (y > 0 && lab[j - w] === 1 && !seen[j - w]) { seen[j - w] = 1; st.push(j - w); }
      if (y < h - 1 && lab[j + w] === 1 && !seen[j + w]) { seen[j + w] = 1; st.push(j + w); }
    }
    if (comp.length > bestSize) { bestSize = comp.length; best = comp; }
  }
  if (!best) return alpha;

  const fg = new Uint8Array(n);
  for (const j of best) fg[j] = 1;

  /* 3. 补洞：从边框出发能走到的背景才算真背景，走不到的就是身上的白毛被抠穿了 */
  const bg = new Uint8Array(n);
  const st = [];
  for (let x = 0; x < w; x++) { st.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y++) { st.push(y * w, y * w + w - 1); }
  while (st.length) {
    const j = st.pop();
    if (bg[j] || fg[j]) continue;
    bg[j] = 1;
    const x = j % w, y = (j / w) | 0;
    if (x > 0) st.push(j - 1);
    if (x < w - 1) st.push(j + 1);
    if (y > 0) st.push(j - w);
    if (y < h - 1) st.push(j + w);
  }
  for (let i = 0; i < n; i++) if (!bg[i] && fg[i] === 0) fg[i] = 1;   // 洞 → 前景

  /* 4. 羽化：在原 alpha 上保留软边（毛发），只把纯背景压到 0 */
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = fg[i] ? Math.max(alpha[i], 0.02) : 0;
    if (fg[i] && alpha[i] < 0.02) out[i] = 0.02;
  }
  return boxBlur(out, w, h, 1);
}

/* ---------------- 边缘去色污染（去白边 / 去背景色晕） ---------------- */
export function decontaminate(id, alpha, w, h) {
  const d = id.data;
  const R = 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = alpha[i];
      if (a <= 0.05 || a >= 0.92) continue;
      let r = 0, g = 0, b = 0, c = 0;
      for (let dy = -R; dy <= R; dy += R) {
        for (let dx = -R; dx <= R; dx += R) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (alpha[j] < 0.95) continue;
          const o = j * 4;
          r += d[o]; g += d[o + 1]; b += d[o + 2]; c++;
        }
      }
      if (!c) continue;
      const o = i * 4;
      /* 边缘像素颜色往「内部实心颜色」拉，alpha 越低拉得越多 */
      const t = 1 - a;
      d[o] = d[o] * (1 - t) + (r / c) * t;
      d[o + 1] = d[o + 1] * (1 - t) + (g / c) * t;
      d[o + 2] = d[o + 2] * (1 - t) + (b / c) * t;
    }
  }
}

/* ---------------- 颈部切线：按行宽找「最细处」 ---------------- */
export function detectNeck(alpha, w, h) {
  const rows = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = 0; x < w; x++) if (alpha[y * w + x] > 0.5) c++;
    rows[y] = c;
  }
  /* 9 行滑动平均，抹掉耳朵/爪子造成的锯齿 */
  const sm = new Float32Array(h);
  const R = 4;
  for (let y = 0; y < h; y++) {
    let s = 0, n = 0;
    for (let k = -R; k <= R; k++) {
      const j = y + k;
      if (j < 0 || j >= h) continue;
      s += rows[j]; n++;
    }
    sm[y] = s / n;
  }
  let maxW = 0;
  for (let y = 0; y < h; y++) maxW = Math.max(maxW, sm[y]);
  if (maxW <= 0) return 0.4;

  /* 内容上下边界：照片上下常有留白/桌面，先量出宠物实际占的那一段，
     否则「颈线」会被算到留白里（实测有张趴姿照片被切到了头顶 18% 处） */
  const TH = maxW * 0.06;
  let top = 0, bot = h - 1;
  while (top < h - 1 && sm[top] < TH) top++;
  while (bot > 0 && sm[bot] < TH) bot--;
  const Hc = Math.max(8, bot - top);

  /* 默认切在内容高度的 30%（脖子大致就在前三分之一） */
  const guess = Math.round(top + Hc * 0.30);

  /* 在默认位置上下 12% 以内找真正的收窄处：坐着/站着的宠物脖子会明显变细。
     趴着的宠物没有收窄（剖面几乎一条直线），这时就用默认位置。
     搜索窗口故意开得小 —— 窗口一大就会滑到胸口的收缩处，把头切掉一半。 */
  const y0 = Math.round(guess - Hc * 0.12), y1 = Math.round(guess + Hc * 0.12);
  let bestY = guess, bestV = Infinity;
  for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
    if (sm[y] < maxW * 0.16) continue;          // 太细的是耳朵缝隙 / 腿间空隙
    if (sm[y] < bestV) { bestV = sm[y]; bestY = y; }
  }
  /* 完全没找到收窄（趴姿）就回默认位置 */
  if (bestV > maxW * 0.94) bestY = guess;

  return clamp(bestY / h, 0.14, 0.66);
}

/* ---------------- 主流程 ---------------- */
/**
 * @param {HTMLImageElement|HTMLCanvasElement} img 已缩放到工作尺寸的原图
 * @param {(msg:string)=>void} onMsg 进度回调
 * @returns {Promise<{layers:object, meta:object, alpha:Float32Array, w:number, h:number}>}
 */
export async function makePuppet(img, onMsg = () => {}) {
  const w = img.width, h = img.height;

  const src = document.createElement("canvas");
  src.width = w; src.height = h;
  const sg = src.getContext("2d", { willReadFrequently: true });
  sg.drawImage(img, 0, 0);

  let alpha = null;
  try {
    onMsg("正在识别宠物轮廓…");
    alpha = await segmentDeepLab(src, w, h);
  } catch (e) {
    console.warn("[matte] DeepLab 不可用，改用 GrabCut", e);
  }

  if (!alpha) {
    onMsg("正在本地抠图（GrabCut）…");
    alpha = grabcutLite(sg.getImageData(0, 0, w, h).data, w, h);
  }

  onMsg("正在清理边缘…");
  alpha = refine(alpha, w, h);

  /* 覆盖太少说明抠失败（比如整张图都黑了、只抠到一张脸），再兜底一次 */
  const ratio = (a) => {
    let c = 0;
    for (let i = 0; i < a.length; i++) if (a[i] > 0.5) c++;
    return c / a.length;
  };
  let cover = ratio(alpha);
  if (cover < 0.06) {
    onMsg("换个算法再试一次…");
    const a2 = refine(grabcutLite(sg.getImageData(0, 0, w, h).data, w, h), w, h);
    const c2 = ratio(a2);
    /* 只有「更完整」的结果才采用，别把本来对的换成错的 */
    if (c2 > cover && c2 < 0.92) { alpha = a2; cover = c2; }
  }

  const neckY = detectNeck(alpha, w, h);

  onMsg("正在生成互动素材…");
  const layers = buildLayers(src, alpha, w, h, neckY);

  return { layers, meta: layers.meta, alpha, w, h, neckY };
}

/** 重新按新的颈部位置切一次头（拖动微调时用，不重新抠图） */
export function recut(srcCanvas, alpha, w, h, neckY) {
  return buildLayers(srcCanvas, alpha, w, h, neckY);
}

function buildLayers(src, alpha, w, h, neckY) {
  /* 1. 带 alpha 的整图 */
  const full = document.createElement("canvas");
  full.width = w; full.height = h;
  const fg = full.getContext("2d");
  fg.drawImage(src, 0, 0);
  const id = fg.getImageData(0, 0, w, h);
  decontaminate(id, alpha, w, h);
  const d = id.data;
  for (let i = 0; i < w * h; i++) d[i * 4 + 3] = Math.round(clamp(alpha[i]) * 255);
  fg.putImageData(id, 0, 0);

  /* 2. 头：颈部切线以上，按 alpha 求 bbox，切线上做 3px 羽化（避免硬边） */
  const cutY = Math.max(8, Math.min(h - 8, Math.round(neckY * h)));
  let x0 = w, x1 = 0, y0 = h;
  for (let y = 0; y < cutY; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 0.25) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
      }
    }
  }
  if (x1 <= x0) { x0 = 0; x1 = w - 1; }
  const pad = 4;
  x0 = Math.max(0, x0 - pad); x1 = Math.min(w - 1, x1 + pad); y0 = Math.max(0, y0 - pad);

  const hw = x1 - x0 + 1, hh = cutY - y0 + 1;
  const head = document.createElement("canvas");
  head.width = hw; head.height = hh;
  const hg = head.getContext("2d");
  hg.drawImage(full, x0, y0, hw, hh, 0, 0, hw, hh);

  /* 底边羽化：颈部那条缝要软，头一动才不会像被切开 */
  hg.globalCompositeOperation = "destination-out";
  const fade = hg.createLinearGradient(0, hh - 4, 0, hh);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(1, "rgba(0,0,0,1)");
  hg.fillStyle = fade;
  hg.fillRect(0, hh - 4, hw, 4);

  const meta = {
    full: { w, h },
    neckY: cutY / h,
    head: {
      w: hw, h: hh,
      px: w / 2 - x0,          // 颈部枢轴在头图里的位置
      py: cutY - y0,
      ox: x0 - w / 2,
      oy: -(h - (y0 + hh)),
    },
    body: { w, h, ox: -w / 2, oy: -h },
    paws: { L: null, R: null },
  };

  return { full, head, meta };
}

/** 生成缩略图（上传列表里用） */
export function makeThumb(full, size = 96) {
  const c = document.createElement("canvas");
  const r = full.width / full.height;
  c.width = r >= 1 ? size : Math.round(size * r);
  c.height = r >= 1 ? Math.round(size / r) : size;
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(full, 0, 0, c.width, c.height);
  return c.toDataURL("image/webp", 0.8);
}
