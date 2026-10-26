/* ============================================================
 * custom.js —— 「上传我的专属宠物」：本地上传 → 复刻 → 保存
 *
 * 隐私边界（写死在这个文件里，不依赖后端）：
 *   · 照片只通过 URL.createObjectURL 读进内存，读完立刻 revoke；
 *   · 抠图、切层、缩略图全部在 Canvas / WASM 里做；
 *   · 没有任何 fetch / XHR / WebSocket 往外发图片；
 *   · 用户点「保存」后，素材存在浏览器 IndexedDB（本机），不上云。
 *
 * 保存的宠物下次打开自动出现在顶部宠物条里（带 ♥）。
 * ============================================================ */

import { makePuppet, recut, makeThumb, loadSegmenter } from "./matte.js";

const DB_NAME = "gesture-pet";
const DB_VER = 1;
const STORE = "pets";

/* ---------------- IndexedDB ---------------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let out;
    try { out = fn(s); } catch (e) { rej(e); return; }
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export async function listSaved() {
  try {
    const all = await tx("readonly", (s) => s.getAll());
    return (all || []).sort((a, b) => a.createdAt - b.createdAt);
  } catch (e) {
    console.warn("[custom] 读取已保存宠物失败", e);
    return [];
  }
}

export async function savePet(rec) { return tx("readwrite", (s) => s.put(rec)); }
export async function removePet(id) { return tx("readwrite", (s) => s.delete(id)); }

/* ---------------- 记录 → 宠物配置 ---------------- */
const VOICE = {
  cat: () => ({ type: "cat", pitch: 400 + Math.random() * 140, rate: 0.88 + Math.random() * 0.22, rough: 0.1 + Math.random() * 0.15 }),
  dog: () => ({ type: "dog", pitch: 230 + Math.random() * 90, rate: 0.95 + Math.random() * 0.3, rough: 0.38 + Math.random() * 0.18 }),
  hamster: () => ({ type: "squeak", pitch: 1350 + Math.random() * 350, rate: 1, rough: 0.04 }),
};
const KIND_NAME = { cat: "猫", dog: "犬", hamster: "仓鼠" };

export function recordToCfg(rec) {
  return {
    id: rec.id,
    name: rec.name,
    full: rec.name + " · 我的宝贝",
    kind: rec.kind,
    aspect: rec.meta.full.w / rec.meta.full.h,
    neckY: rec.meta.neckY,
    size: rec.kind === "hamster" ? 0.78 : 1,
    voice: rec.voice,
    desc: "从我自己的照片复刻的",
    tint: rec.tint || "#c8b49c",
    custom: true,
    imgFull: rec.full,
    imgHead: rec.head,
    meta: rec.meta,
    pawMode: false,          // 单张照片无法拆出独立四肢层 → 跑动用整体起伏
  };
}

/* ---------------- 小工具 ---------------- */
const loadImg = (src) =>
  new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });

function fitCanvas(im, maxSide = 640) {
  const r = Math.min(1, maxSide / Math.max(im.width, im.height));
  const c = document.createElement("canvas");
  c.width = Math.max(8, Math.round(im.width * r));
  c.height = Math.max(8, Math.round(im.height * r));
  const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  g.drawImage(im, 0, 0, c.width, c.height);
  return c;
}

/** 取宠物主色（给顶部宠物条的小圆点用） */
function dominantColor(canvas) {
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
  let r = 0, gg = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++;
  }
  if (!n) return "#c8b49c";
  const hex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${hex(r / n)}${hex(gg / n)}${hex(b / n)}`;
}

/* ============================================================
 * 上传面板
 * ============================================================ */
export function initCustom(opts = {}) {
  const { onCreated = () => {}, onOpenChange = () => {} } = opts;

  /* ---- DOM ---- */
  const wrap = document.createElement("div");
  wrap.className = "modal";
  wrap.id = "petModal";
  wrap.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mTitle">
      <button class="x" type="button" aria-label="关闭">×</button>

      <div class="step" data-step="pick">
        <h2 id="mTitle">上传我的专属宠物</h2>
        <p class="soft">它不在了，但它还可以在这里，被你摸一摸。</p>

        <label class="drop" id="drop">
          <input type="file" id="file" accept="image/*" multiple hidden>
          <b>选择照片</b>
          <span>一张就够，正面 · 全身 · 光线均匀最好</span>
        </label>

        <div class="thumbs" id="thumbs"></div>

        <div class="row2">
          <label class="fld">它是
            <select id="kindSel">
              <option value="cat">猫咪</option>
              <option value="dog">狗狗</option>
              <option value="hamster">小动物</option>
            </select>
          </label>
          <label class="fld">叫它
            <input id="nameIn" maxlength="8" placeholder="我的宝贝">
          </label>
        </div>

        <p class="privacy">
          <span class="lock" aria-hidden="true"></span>
          照片仅用于本次宠物形象生成，不会保存、不会泄露。
        </p>

        <button class="primary wide" id="genBtn" type="button" disabled>生成专属宠物</button>
      </div>

      <div class="step" data-step="edit" hidden>
        <h2>看看像不像</h2>
        <p class="soft">如果头的位置不太对，拖一下这条线。</p>
        <div class="prevWrap"><canvas id="prev"></canvas></div>
        <label class="fld wide">
          <span>脖子位置</span>
          <input type="range" id="neck" min="16" max="70" step="0.5">
        </label>
        <div class="btns">
          <button class="primary" id="doneBtn" type="button">保存我的宠物</button>
          <button class="ghost" id="onceBtn" type="button">只玩这次</button>
        </div>
        <p class="privacy small">保存后只存在这台设备的浏览器里，换设备/清缓存会消失。</p>
      </div>

      <div class="step busy" data-step="busy" hidden>
        <div class="ring"></div>
        <p id="busyMsg">正在准备…</p>
        <small>全部在本机完成，照片没有离开你的电脑</small>
      </div>
    </div>`;

  document.body.appendChild(wrap);

  const $ = (s, el = wrap) => el.querySelector(s);
  const steps = { pick: $('[data-step="pick"]'), edit: $('[data-step="edit"]'), busy: $('[data-step="busy"]') };
  const fileIn = $("#file");
  const thumbs = $("#thumbs");
  const genBtn = $("#genBtn");
  const kindSel = $("#kindSel");
  const nameIn = $("#nameIn");
  const prev = $("#prev");
  const neckIn = $("#neck");

  let firstImage = null;      // 主照片（Image）
  let workCanvas = null;      // 缩放后的工作画布
  let puppet = null;          // { layers, meta, alpha, w, h, neckY }
  let srcCanvas = null;

  const show = (k) => {
    Object.entries(steps).forEach(([key, el]) => { el.hidden = key !== k; });
    wrap.classList.toggle("busyMode", k === "busy");
  };

  const reset = () => {
    firstImage = null; workCanvas = null; puppet = null; srcCanvas = null;
    thumbs.innerHTML = "";
    genBtn.disabled = true;
    fileIn.value = "";
    show("pick");
  };

  const open = () => {
    wrap.classList.add("on");
    document.body.classList.add("modalOpen");
    reset();
    onOpenChange(true);
  };
  const close = () => {
    wrap.classList.remove("on");
    document.body.classList.remove("modalOpen");
    onOpenChange(false);
    /* 关闭即丢弃内存里的图像引用（隐私承诺的一部分） */
    setTimeout(reset, 260);
  };

  $(".x").addEventListener("click", close);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && wrap.classList.contains("on")) close();
  });

  /* ---- 选照片 ---- */
  fileIn.addEventListener("change", () => {
    const files = [...(fileIn.files || [])].slice(0, 4);
    thumbs.innerHTML = "";
    if (!files.length) { genBtn.disabled = true; return; }

    files.forEach((f, i) => {
      const url = URL.createObjectURL(f);
      const img = document.createElement("img");
      img.src = url;
      img.alt = "照片 " + (i + 1);
      img.onload = () => URL.revokeObjectURL(url);   // 解码完立刻释放
      thumbs.appendChild(img);
      if (i === 0) firstImage = img;
    });
    genBtn.disabled = false;

    const nm = files[0].name.replace(/\.[^.]+$/, "").slice(0, 8);
    if (!nameIn.value && nm) nameIn.placeholder = nm;
  });

  /* ---- 生成 ---- */
  genBtn.addEventListener("click", async () => {
    if (!firstImage || !firstImage.width) return;
    show("busy");
    const msg = $("#busyMsg");
    try {
      await loadSegmenter((m) => (msg.textContent = m));
      workCanvas = fitCanvas(firstImage, 640);
      puppet = await makePuppet(workCanvas, (m) => (msg.textContent = m));
      srcCanvas = workCanvas;

      const nk = puppet.neckY;
      neckIn.min = "16"; neckIn.max = "70";
      neckIn.value = String(Math.round(nk * 1000) / 10);
      drawPreview(nk);
      show("edit");
    } catch (e) {
      console.error("[upload]", e);
      msg.textContent = "生成失败：" + (e && e.message ? e.message : e) + "（换一张光线更均匀的照片试试）";
      setTimeout(() => { show("pick"); }, 2200);
    }
  });

  /* ---- 脖子位置微调 ---- */
  let neckRaf = 0;
  neckIn.addEventListener("input", () => {
    if (!srcCanvas) return;
    cancelAnimationFrame(neckRaf);
    neckRaf = requestAnimationFrame(() => {
      const v = +neckIn.value / 100;
      puppet.layers = recut(srcCanvas, puppet.alpha, puppet.w, puppet.h, v);
      puppet.meta = puppet.layers.meta;
      drawPreview(v);
    });
  });

  function drawPreview(neckY) {
    if (!puppet) return;
    const { layers, w, h } = puppet;
    const CW = 360, CH = 300;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    prev.width = CW * dpr; prev.height = CH * dpr;
    prev.style.width = CW + "px"; prev.style.height = CH + "px";
    const g = prev.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    /* 用同款底色 + 接触阴影，让用户看到的就是最终效果 */
    const bg = g.createLinearGradient(0, 0, 0, CH);
    bg.addColorStop(0, "#efe2d0");
    bg.addColorStop(0.62, "#dcc6a9");
    bg.addColorStop(1, "#c3a37c");
    g.fillStyle = bg;
    g.fillRect(0, 0, CW, CH);

    const scale = Math.min((CH * 0.82) / h, (CW * 0.8) / w);
    const dw = w * scale, dh = h * scale;
    const cx = CW / 2, gy = CH * 0.92;

    g.save();
    g.globalAlpha = 0.3;
    g.filter = "blur(6px)";
    g.fillStyle = "#3a2414";
    g.beginPath();
    g.ellipse(cx, gy, dw * 0.36, dh * 0.045, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();

    g.drawImage(layers.full, cx - dw / 2, gy - dh, dw, dh);

    /* 脖子参考线 */
    const ny = gy - dh + (layers.meta.neckY) * dh;
    g.save();
    g.strokeStyle = "rgba(226,120,90,0.75)";
    g.lineWidth = 1.5;
    g.setLineDash([5, 4]);
    g.beginPath();
    g.moveTo(cx - dw * 0.48, ny);
    g.lineTo(cx + dw * 0.48, ny);
    g.stroke();
    g.restore();
  }

  /* ---- 落地 ---- */
  async function finish(save) {
    if (!puppet) return;
    const kind = kindSel.value;
    const name = (nameIn.value || nameIn.placeholder || "我的宝贝").slice(0, 8);

    const fullURL = puppet.layers.full.toDataURL("image/webp", 0.92);
    const headURL = puppet.layers.head.toDataURL("image/webp", 0.92);
    const thumbURL = makeThumb(puppet.layers.full, 120);
    const tint = dominantColor(puppet.layers.full);

    const rec = {
      id: "u" + Date.now().toString(36),
      name, kind,
      voice: (VOICE[kind] || VOICE.cat)(),
      meta: puppet.meta,
      full: fullURL, head: headURL, thumb: thumbURL, tint,
      createdAt: Date.now(),
    };

    if (save) {
      try { await savePet(rec); }
      catch (e) { console.warn("[custom] 保存失败", e); }
    }
    onCreated(recordToCfg(rec), save);
    close();
  }

  $("#doneBtn").addEventListener("click", () => finish(true));
  $("#onceBtn").addEventListener("click", () => finish(false));

  return { open, close };
}

export { KIND_NAME };
