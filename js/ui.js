/* ============================================================
 * ui.js —— 顶部切换菜单、设置面板、HUD、启动遮罩
 *
 * 只负责 DOM：不碰识别、不碰渲染，所有动作通过回调交出去。
 * 宠物条是动态的：内置 7 只 + 用户复刻的（带 ♥），所以做成可重建。
 * ============================================================ */

export function buildUI(pets, h) {
  const $ = (id) => document.getElementById(id);
  const nav = $("pets");

  let chips = [];
  let active = -1;

  function render() {
    nav.innerHTML = "";
    chips = pets.map((p, i) => {
      const b = document.createElement("button");
      b.className = "chip" + (p.custom ? " mine" : "");
      b.type = "button";
      b.title = p.full || p.name;
      b.innerHTML = `<i style="background:${p.tint || "#c8b49c"}"></i><span>${p.name}</span>` +
        (p.custom ? '<em class="heart">♥</em>' : "");
      b.addEventListener("click", () => h.onPet(i));
      nav.appendChild(b);
      return b;
    });
    if (active >= 0) applyActive();
  }

  function applyActive() {
    chips.forEach((c, k) => c.classList.toggle("on", k === active));
    const chip = chips[active];
    if (chip && chip.scrollIntoView) {
      chip.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    }
  }

  const api = {
    render,
    setPet(i) {
      if (i === active) return;
      active = i;
      applyActive();
    },
    setPets() {
      render();
      if (active >= chips.length - 1) active = chips.length - 1;
      applyActive();
    },
    get active() { return active; },
    setGesture(text, mood) {
      const el = $("hud");
      el.textContent = text;
      el.classList.toggle("hot", mood > 0.55);
    },
    toast(text) {
      const t = $("toast");
      t.textContent = text;
      t.classList.add("show");
      clearTimeout(api._tt);
      api._tt = setTimeout(() => t.classList.remove("show"), 1300);
    },
    setCameraState(on) {
      document.body.classList.toggle("hascam", on);
    },
    setBloomMode(on) {
      document.body.classList.toggle("bloom", on);
      $("bloomTag").textContent = on ? "开花彩蛋" : "隔空撸宠";
    },
    hideStart() {
      const s = $("start");
      s.classList.add("gone");
      setTimeout(() => s.remove(), 500);
    },
    startError(msg) {
      $("startMsg").textContent = msg;
      $("start").classList.add("err");
    },
  };

  render();

  /* ---------- 设置面板 ---------- */
  const panel = $("panel");
  $("gear").addEventListener("click", (e) => {
    e.stopPropagation();
    panel.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (panel.classList.contains("open") && !panel.contains(e.target) && e.target.id !== "gear") {
      panel.classList.remove("open");
    }
  });

  const sens = $("sens");
  sens.value = h.sens * 100;
  sens.addEventListener("input", () => h.onSens(+sens.value / 100));

  const vol = $("vol");
  vol.value = h.vol * 100;
  vol.addEventListener("input", () => h.onVol(+vol.value / 100));

  const pts = $("showPts");
  pts.checked = h.showPts;
  pts.addEventListener("change", () => h.onShowPts(pts.checked));

  const cam = $("showCam");
  cam.checked = h.showCam;
  cam.addEventListener("change", () => h.onShowCam(cam.checked));

  $("bloomBtn").addEventListener("click", () => {
    panel.classList.remove("open");
    h.onBloomToggle();
  });

  /* ---------- 上传我的专属宠物 ---------- */
  const adopt = $("adopt");
  if (adopt) adopt.addEventListener("click", () => h.onAdopt());

  /* ---------- 启动 ---------- */
  $("startCam").addEventListener("click", () => h.onStart(true));
  $("startDemo").addEventListener("click", () => h.onStart(false));

  return api;
}
