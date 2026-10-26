/* ============================================================
 * test-logic.mjs —— 交互逻辑自测（不需要浏览器 / 摄像头）
 *
 * 跑法：
 *   node tools/test-logic.mjs
 *
 * 它做的事情：用固定 60fps 的时间轴伪造「手在宠物身上的运动」，
 * 把 pet.js 的状态机、手势动作、音效事件全部跑一遍，检查：
 *   · 六种手势是否都能稳定触发
 *   · 姿态量是否在合理范围（NaN / 数值爆掉会立刻报出来）
 *   · 待机循环是否还会进入「睡着」状态（新需求里必须移除）
 * ============================================================ */

import { PETS } from "../js/config.js";
import { Pet } from "../js/pet.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log("  ok   " + msg); }
  else { fail++; console.log("  FAIL " + msg); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const num = (v) => typeof v === "number" && Number.isFinite(v);

/* 伪造一只手的输入 */
const idle = { active: false, zone: null, d: 9, lx: 0, ly: 0, brushing: false, tap: false, twoHands: false };
const info = (o) => ({ ...idle, ...o });

let CLOCK = 0;
function run(pet, ms, makeInfo) {
  const dt = 1 / 60;
  let t = 0;
  while (t < ms) {
    CLOCK += dt * 1000;
    t += dt * 1000;
    pet.update(dt, makeInfo ? makeInfo(t) : idle, CLOCK);
  }
}

console.log("\n[1] 摸头：低头 + 两声低吟");
{
  const p = new Pet(PETS[5]);
  run(p, 400, () => info({ active: true, zone: "head", d: -0.04, lx: 0, ly: -0.78 }));
  const voices = p.events.filter((e) => e.type === "voice");
  ok(p.state === "down", "进入 down 状态（实际 " + p.state + "）");
  ok(p.pose.headDY > 0.02, "头部下沉 headDY=" + p.pose.headDY.toFixed(4));
  ok(voices.length >= 2, "抛出 " + voices.length + " 声低吟（要求 2 声）");
  ok(voices.every((e) => e.low && e.low < 1), "低吟带 low<1 的音高标记");
  ok(p.pose.headDY < 0.2 && num(p.pose.headDY), "下沉幅度没爆掉");
}

console.log("[2] 张开手：原地转一圈（sx 由 1 → -1 → 1）");
{
  const p = new Pet(PETS[0]);
  run(p, 200);
  ok(p.spin(CLOCK) === true, "spin() 触发");
  let minSx = 9;
  for (let i = 0; i < 40; i++) {
    CLOCK += 16.7;
    p.update(1 / 60, idle, CLOCK);
    minSx = Math.min(minSx, p.pose.sx);
  }
  ok(minSx < -0.6, "转过 180°：sx 最小 " + minSx.toFixed(2));
  ok(p.events.some((e) => e.type === "voice" && e.short), "伴随一声短促叫声");
  run(p, 1800);
  ok(near(p.pose.sx, 1, 0.06), "转完回正 sx=" + p.pose.sx.toFixed(3));
  ok(!p.spin(CLOCK), "冷却期内不会连续触发");
}

console.log("[3] 轻点：短叫 + 歪头");
{
  const p = new Pet(PETS[3]);
  run(p, 150);
  p.tapReact();
  let peak = 0;
  for (let i = 0; i < 70; i++) {
    CLOCK += 16.7;
    p.update(1 / 60, idle, CLOCK);
    peak = Math.max(peak, Math.abs(p.pose.headRot));
  }
  ok(peak > 0.2, "歪头峰值 " + peak.toFixed(2) + " rad");
  ok(p.events.some((e) => e.type === "voice" && e.short), "短叫一声");
  run(p, 900);
  ok(Math.abs(p.pose.headRot) < 0.06, "歪完回正 headRot=" + p.pose.headRot.toFixed(3));
}

console.log("[4] 挥手：朝手势方向跑 + 交替踏步");
{
  const p = new Pet(PETS[4]);
  p.W = 1200;
  run(p, 150);
  p.run(1, CLOCK);
  let maxX = 0, maxPawDiff = 0;
  for (let i = 0; i < 60; i++) {
    CLOCK += 16.7;
    p.update(1 / 60, idle, CLOCK);
    maxX = Math.max(maxX, p.pose.x);
    maxPawDiff = Math.max(maxPawDiff, Math.abs(p.pose.pawL - p.pose.pawR));
  }
  ok(maxX > 50, "向右跑动 " + maxX.toFixed(0) + "px");
  ok(maxPawDiff > 0.01, "两只前爪交替抬起（差值峰值 " + maxPawDiff.toFixed(4) + "，不是整体平移）");

  const q = new Pet(PETS[4]);
  q.W = 1200;
  run(q, 100);
  q.run(-1, CLOCK);
  let minX = 0;
  for (let i = 0; i < 60; i++) { CLOCK += 16.7; q.update(1 / 60, idle, CLOCK); minX = Math.min(minX, q.pose.x); }
  ok(minX < -50, "向左跑动 " + minX.toFixed(0) + "px");
}

console.log("[5] 双手入镜：地上打滚 + 嘤嘤嘤");
{
  const p = new Pet(PETS[6]);
  run(p, 200);
  run(p, 400, () => info({ active: true, zone: "back", d: -0.03, brushing: true, twoHands: true }));
  ok(p.act && p.act.name === "roll", "触发了 " + (p.act && p.act.name));
  let minRot = 0;
  for (let i = 0; i < 170; i++) {
    CLOCK += 16.7;
    p.update(1 / 60, idle, CLOCK);
    minRot = Math.min(minRot, p.pose.rot);
  }
  ok(minRot < -5.5, "整体翻转 " + (minRot / Math.PI).toFixed(2) + "π");
  const squeaks = p.events.filter((e) => e.type === "voice" && e.squeak);
  ok(squeaks.length >= 3, "嘤嘤嘤 " + squeaks.length + " 声");
}

console.log("[6] 待机：眨眼 / 舔爪 / 打哈欠，不再睡着");
{
  const p = new Pet(PETS[1]);
  const seen = new Set();
  let slept = false;
  for (let i = 0; i < 60 * 60; i++) {
    CLOCK += 16.7;
    p.update(1 / 60, idle, CLOCK);
    if (p.state === "sleep") slept = true;
    if (p.idleAct) seen.add(p.idleAct);
  }
  ok(!slept, "60 秒内没有进入 sleep 状态（需求：移除睡着）");
  ok(seen.size >= 2, "待机动作轮换到 " + [...seen].join("/"));
  ok(p.state === "idle", "长时间无输入仍是 idle（实际 " + p.state + "）");
}

console.log("[7] 悬停 / 抚摸 / 数值健康检查");
{
  const p = new Pet(PETS[2]);
  run(p, 300, () => info({ active: true, zone: "head", d: 1.2, lx: 0.1, ly: -0.7 }));
  ok(p.state === "hover", "悬停状态（" + p.state + "）");
  run(p, 300, () => info({ active: true, zone: "back", d: -0.02, brushing: true, lx: 0, ly: -0.3 }));
  ok(p.state === "pet", "抚摸状态（" + p.state + "）");
  ok(Object.values(p.pose).every(num), "pose 全部是有限数值（无 NaN）");
  ok(p.mood >= 0 && p.mood <= 1, "满足度在 0~1（" + p.mood.toFixed(2) + "）");
  ok(p.events.every((e) => ["voice", "purr"].includes(e.type)), "事件类型合法");
}

console.log("\n[8] 7 只宠物都能初始化并跑 2 秒");
{
  for (const cfg of PETS) {
    const p = new Pet(cfg);
    run(p, 2000, (t) => info({ active: true, zone: "back", d: -0.02, brushing: true, lx: Math.sin(t / 200) * 0.2, ly: -0.3 }));
    ok(num(p.pose.headDX) && num(p.pose.sx) && p.mood > 0, cfg.name + "：状态 " + p.state + "，满足度 " + p.mood.toFixed(2));
  }
}

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败\n");
process.exit(fail ? 1 : 0);
