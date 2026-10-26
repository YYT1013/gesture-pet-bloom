/* ============================================================
 * touch.js —— 把「指尖在屏幕上的位置」变成「摸到宠物哪儿了」
 *
 * 三件事：
 *   1. 屏幕坐标 → 宠物本地坐标（除以缩放，减掉宠物位置），与分辨率无关；
 *   2. 滑动窗口内的累计路径 → 判断这一下是「点」还是「抚摸」；
 *   3. 与身体分区的有符号距离 → 判断摸到 / 悬停 / 没碰到。
 *
 * 没有用任何物理引擎：撸宠的手感靠的就是「距离 + 路径 + 弹簧」三样东西。
 * ============================================================ */

import { TOUCH } from "./config.js";

const WIN_MS = TOUCH.brushWindow;   // 滑动窗口

export class TouchTracker {
  constructor() {
    this.samples = [];        // {x, y, t} 本地坐标
    this.inContact = false;
    this.t0 = 0;
    this.tapped = false;
    this.everContacted = false;
    this.vx = 0; this.vy = 0;
    this.lx = 0; this.ly = 0;
  }

  reset() {
    this.samples.length = 0;
    this.inContact = false;
    this.petting = false;
    this.tapped = false;
  }

  /* x, y：指尖在画布上的像素坐标 */
  sample(x, y, now, pet) {
    const lx = (x - pet.cx) / pet.S;
    const ly = (y - pet.cy) / pet.S;
    const prev = this.samples[this.samples.length - 1];
    this.samples.push({ x: lx, y: ly, t: now });
    while (this.samples.length && now - this.samples[0].t > WIN_MS) this.samples.shift();
    if (prev) {
      const dt = Math.max(8, now - prev.t) / 1000;
      this.vx = (lx - prev.x) / dt;
      this.vy = (ly - prev.y) / dt;
    }
    this.lx = lx; this.ly = ly;
    return this;
  }

  /* 由 pet.hit() 的结果补齐「这一下算什么动作」 */
  analyze(pet, sens, now) {
    const { zone, d } = pet.hit(this.lx, this.ly, sens);
    const contact = d < 0;
    // 滑动窗口内的累计路径长度：手停下后会自然衰减到 0，手感更真
    let path = 0;
    for (let i = 1; i < this.samples.length; i++) {
      path += Math.hypot(this.samples[i].x - this.samples[i - 1].x, this.samples[i].y - this.samples[i - 1].y);
    }

    if (contact && !this.inContact) {
      this.inContact = true;
      this.everContacted = true;
      this.t0 = now;
      this.tapped = false;
    } else if (!contact) {
      this.inContact = false;
    }

    // 点按：接触时间短、几乎没位移 —— 一次接触只触发一次
    const dur = now - this.t0;
    let isTap = false;
    if (contact && this.inContact && !this.tapped && dur > 90 && dur < TOUCH.tapMs && path < TOUCH.tapMove) {
      isTap = true;
      this.tapped = true;
    }

    // 抚摸判定带迟滞：进入要刷够 0.22 个体长，退出只要停顿到 0.08 以下，
    // 免得手速稍微一变就在「摸到 / 抚摸」之间来回跳
    const th = this.petting ? TOUCH.brushLength * 0.36 : TOUCH.brushLength;
    this.petting = contact && path > th;

    return {
      active: contact || d < TOUCH.hoverBand,
      contact,
      zone,
      d,
      lx: this.lx,
      ly: this.ly,
      vx: this.vx,
      vy: this.vy,
      path,
      brushing: this.petting,
      tap: isTap,
      dur,
    };
  }
}

/* 两手合并：取更近的那只手作为主交互，另一只作为「双手摸」的加成 */
export function mergeTouches(a, b) {
  if (!a) return b;
  if (!b) return a;
  const main = a.d <= b.d ? a : b;
  return { ...main, twoHands: a.contact && b.contact };
}
