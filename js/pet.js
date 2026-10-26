/* ============================================================
 * pet.js —— 宠物本体：身体分区、手势行为状态机、物理反馈
 *
 * 状态机分两层：
 *   1. 触摸层：idle / hover / touch / pet（抚摸）/ down（摸头低头）
 *   2. 动作层：spin（转圈）/ run（跑）/ roll（打滚）/ tilt（歪头）
 *      动作层是一次性的时间轴，播放期间盖住触摸层的姿态，
 *      播完自动回到触摸层 —— 这样「摸头」和「转一圈」不会打架。
 *
 * 所有姿态量（pose）都以「素材高度 = 1.0」为单位，渲染层乘素材像素高即可，
 * 所以换更大的素材、换屏幕分辨率，动作幅度都不用重调。
 * ============================================================ */

import { TOUCH, GEST } from "./config.js";

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

/* 缓动：真实动物动作是「起快收慢」，不要线性 */
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

/* 弹簧：触摸位移、抖动、歪头的回弹都用它 */
class Spring {
  constructor(x = 0, k = 140, d = 15) { this.x = x; this.v = 0; this.k = k; this.d = d; }
  step(target, dt) {
    // 固定步长积分，掉帧时也不会炸
    const h = Math.min(0.033, dt);
    this.v += (target - this.x) * this.k * h - this.v * this.d * h;
    this.x += this.v * h;
    return this.x;
  }
  kick(impulse) { this.v += impulse; }
  reset() { this.x = 0; this.v = 0; }
}

function sdfEllipse(dx, dy, rx, ry) {
  const k = Math.hypot(dx / rx, dy / ry);
  return (k - 1) * Math.min(rx, ry);
}

export class Pet {
  constructor(cfg) {
    this.cfg = cfg;
    this.S = 300;              // 显示高度（render 每帧写入，触摸判定要用）
    this.cx = 0; this.cy = 0;  // 脚下中心（画布像素）
    this.dispH = 300;

    this.state = "idle";
    this.stateT = 0;
    this.mood = 0.15;
    this.now = 0;

    /* ---- 姿态（渲染只读） ---- */
    this.pose = {
      x: 0, y: 0,             // 画布像素位移
      rot: 0,                 // 整体旋转（打滚）
      sx: 1, sy: 1,           // 整体缩放（呼吸 / 转身 / 压扁）
      headDX: 0, headDY: 0,   // 头部偏移（素材高度比例）
      headRot: 0,             // 头部旋转（低头 / 歪头）
      pawL: 0, pawR: 0,       // 前爪抬起（素材高度比例）
    };
    this.dust = 0;

    /* ---- 内部物理量 ---- */
    this.headDX = new Spring();
    this.headDY = new Spring();
    this.headRot = new Spring(0, 120, 13);
    this.shiver = 0;
    this.breath = 0;
    this.wagPhase = 0;

    /* ---- 眨眼 ---- */
    this.blink = 0;
    this.blinkT = rand(1.2, 3);

    /* ---- 一次性动作 ---- */
    this.act = null;            // { name, t0, dur, dir, ... }
    this.runOffset = 0;         // 跑动后的横向偏移（会慢慢回中）

    /* ---- 待机小动作 ---- */
    this.idleAct = "breathe";
    this.idleT = rand(1.0, 2.4);
    this.idleNext = rand(GEST.idleMin, GEST.idleMax);

    /* ---- 手势去抖 ---- */
    this.lastSpin = -1e9;
    this.lastRoll = -1e9;
    this.lastWave = -1e9;

    this.events = [];           // { type:'voice', soft, low } | { type:'purr' }
    this.gesture = "待机";
    this.lastVoice = -1e9;
    this.purrT = -1e9;
    this.twoHandT = 0;
    this.lastDownCall = -1e9;
    this.earShakeT = 0;
  }

  /* ---------------- 身体分区 ----------------
   * 由实拍素材的宽高比和颈部位置推出来，所以每只宠物自动贴合自己的形状。
   * 坐标：脚底 = 0，头顶 = -1（和渲染层一致）。
   * neckY 是「颈部切线在素材高度上的位置（从顶部往下）」，
   * 所以头部占 -1 ~ -1+neckY，身体占 -1+neckY ~ 0。 */
  zones() {
    const a = this.cfg.aspect || 0.6;
    const n = clamp(this.cfg.neckY || 0.42, 0.20, 0.70);   // 头部高度占比
    const b = 1 - n;                                        // 身体高度占比
    return {
      head: { x: 0, y: -1 + n * 0.52, rx: Math.min(0.30, a * 0.32), ry: n * 0.50 },
      face: { x: 0, y: -1 + n * 0.44, rx: Math.min(0.17, a * 0.21), ry: n * 0.27 },
      back: { x: 0, y: -b * 0.52, rx: a * 0.34, ry: b * 0.48 },
      tail: { x: a * 0.40, y: -b * 0.45, rx: 0.08, ry: 0.09 },
    };
  }

  /* 命中判定：返回 { zone, d }，d 已归一化成「灵敏度单位」 */
  hit(lx, ly, sens) {
    const z = this.zones();
    const dist = (o) => sdfEllipse(lx - o.x, ly - o.y, o.rx, o.ry);
    const dFace = dist(z.face), dHead = dist(z.head), dBack = dist(z.back), dTail = dist(z.tail);
    let zone = null, d = Infinity;
    if (dFace < 0) { zone = "face"; d = dFace; }
    if (dHead < 0 && dHead < d) { zone = "head"; d = dHead; }
    if (dBack < 0 && dBack < d) { zone = "back"; d = dBack; }
    if (dTail < 0 && dTail < d) { zone = "tail"; d = dTail; }
    if (!zone) {
      const all = [["head", dHead], ["back", dBack], ["face", dFace], ["tail", dTail]];
      all.sort((p, q) => p[1] - q[1]);
      zone = all[0][0];
      d = all[0][1];
    }
    return { zone, d: d / sens };
  }

  /* ---------------- 每帧 ---------------- */
  update(dt, info, now) {
    this.now = now;
    this.stateT += dt;
    const prev = this.state;
    const setState = (s) => { if (this.state !== s) { this.state = s; this.stateT = 0; } };

    const contacting = info.active && info.d < 0;
    const petting = contacting && info.brushing;

    /* ---------- 1. 触摸层状态 ---------- */
    if (contacting) {
      if (info.zone === "head" || info.zone === "face") setState("down");
      else if (petting) setState("pet");
      else setState("touch");
    } else if (info.active && info.d < TOUCH.hoverBand) {
      setState("hover");
    } else if (this.state === "pet" || this.state === "touch" || this.state === "down" || this.state === "hover") {
      setState("happy");
    } else if (this.state === "happy" && this.stateT > 2.4) {
      setState("idle");
    }

    /* ---------- 2. 满足度 ---------- */
    if (this.state === "pet") this.mood = clamp(this.mood + dt * 0.36);
    else if (this.state === "down" || this.state === "touch") this.mood = clamp(this.mood + dt * 0.2);
    else this.mood = clamp(this.mood - dt * 0.05);

    /* ---------- 3. 摸头：两声低吟 ---------- */
    if (this.state === "down" && now - this.lastDownCall > 1500) {
      this.lastDownCall = now;
      this.events.push({ type: "voice", soft: true, low: 0.86 });
      this.events.push({ type: "voice", soft: true, low: 0.8, delay: 320 });
    }
    /* 抚摸中的呼噜 / 轻哼 */
    if (this.state === "pet" && now - this.purrT > 1400) {
      this.purrT = now;
      this.events.push({ type: "purr" });
      if (now - this.lastVoice > 3200) {
        this.lastVoice = now;
        this.events.push({ type: "voice", soft: true, low: 0.95 });
      }
    }

    /* ---------- 4. 双手：开始打滚 ---------- */
    if (info.twoHands) {
      this.twoHandT += dt;
      if (this.twoHandT > TOUCH.twoHandMs / 1000 && now - this.lastRoll > 2600) this.roll(now);
    } else {
      this.twoHandT = 0;
    }

    /* ---------- 5. 轻点：短叫 + 歪头 ---------- */
    if (info.tap) this.tapReact();

    /* ---------- 6. 目标姿态（触摸层） ---------- */
    let tHeadDY = 0, tHeadDX = 0, tHeadRot = 0, tSy = 1, tSx = 1, tY = 0;

    if (this.state === "down") {
      // 低下头：头往下沉、往前扣一点，身体跟着塌一点 —— 舒服享受的姿态
      tHeadDY = 0.050;
      tHeadRot = 0.065;
      tSy = 0.975;
      tY = 0.008 * this.dispH;
      // 冲量只在「刚摸到头」的那一帧给一次，每帧都给会把弹簧打飞
      if (prev !== "down") this.headDY.kick(0.9);
    } else if (this.state === "pet") {
      // 摸背：背脊抖 + 身体放松
      tHeadDY = 0.012;
      tSy = 0.99;
      tSx = 1.012;
    } else if (this.state === "touch") {
      // 摸到但没刷动：头轻轻往手指方向偏
      tHeadDX = clamp((info.lx || 0) * 0.06, -0.035, 0.035);
      tHeadDY = 0.008;
    } else if (this.state === "hover") {
      // 悬停：跟着手看
      tHeadDX = clamp((info.lx || 0) * 0.10, -0.05, 0.05);
      tHeadRot = clamp((info.lx || 0) * 0.10, -0.06, 0.06);
    }

    /* ---------- 7. 待机小动作 ---------- */
    if (this.state === "idle" || this.state === "happy") {
      this.idleT -= dt;
      if (this.idleT <= 0) this.nextIdle();
      const u = clamp(1 - this.idleT / this.idleDur, 0, 1);
      const w = Math.sin(u * Math.PI);   // 0→1→0 的包络
      if (this.idleAct === "look") {
        tHeadDX += Math.sin(u * Math.PI * 2) * 0.045 * w;
        tHeadRot += Math.sin(u * Math.PI * 2) * 0.05 * w;
      } else if (this.idleAct === "lick") {
        // 舔爪：头低下去、往一侧歪，反复两下
        tHeadDY += (0.055 + Math.sin(u * Math.PI * 6) * 0.012) * w;
        tHeadRot += (0.14 + Math.sin(u * Math.PI * 6) * 0.04) * w;
        tHeadDX += -0.02 * w;
      } else if (this.idleAct === "yawn") {
        // 打哈欠：头先抬后低，身体往前伸
        tHeadRot += -0.10 * Math.sin(u * Math.PI) + 0.05 * Math.sin(u * Math.PI * 2);
        tHeadDY += -0.018 * Math.sin(u * Math.PI);
        tSy += 0.012 * w;
      } else if (this.idleAct === "blink") {
        // 照片没法真的眨眼，用「头快速沉一下 + 身体一缩」带过这个节拍
        tHeadDY += 0.012 * Math.sin(u * Math.PI);
      }
    }

    /* ---------- 8. 呼吸 ---------- */
    this.breath += dt * (1.5 + this.mood * 1.1 + (this.state === "hover" ? 0.5 : 0));
    const breathe = Math.sin(this.breath) * 0.008;
    tSy += breathe;

    /* ---------- 9. 抚摸时的高频抖动 ---------- */
    if (this.state === "pet") {
      this.shiver = Math.min(1, this.shiver + dt * 5);
    } else {
      this.shiver = Math.max(0, this.shiver - dt * 3);
    }

    /* ---------- 10. 弹簧跟随 ---------- */
    this.headDX.step(tHeadDX, dt);
    this.headDY.step(tHeadDY, dt);
    this.headRot.step(tHeadRot, dt);

    const p = this.pose;
    p.x = 0;
    p.headDX = this.headDX.x;
    p.headDY = this.headDY.x;
    p.headRot = this.headRot.x;
    p.sy = tSy;
    p.sx = tSx;
    p.y = tY;
    p.rot = 0;
    p.pawL = 0; p.pawR = 0;

    if (this.shiver > 0.02) {
      p.headDX += (Math.random() - 0.5) * 0.004 * this.shiver;
      p.sx *= 1 + (Math.random() - 0.5) * 0.012 * this.shiver;
    }

    /* ---------- 11. 一次性动作叠加（优先级最高） ---------- */
    this.updateAction(dt, now);

    /* ---------- 12. 眨眼 ---------- */
    this.blinkT -= dt;
    if (this.blinkT <= 0) {
      this.blinkT = rand(2.6, 6.5);
      this.blink = 1;
    }
    this.blink = Math.max(0, this.blink - dt * 7.5);

    /* ---------- 13. 文案 ---------- */
    this.gesture = this.act ? ({
      spin: "转了个圈", run: "跑过去", roll: "舒服到打滚", tilt: "歪头看你",
    }[this.act.name] || "动了") : (
      this.state === "down" ? "摸头 · 低着头好舒服"
        : this.state === "pet" ? (info.zone === "back" ? "摸背 · 舒服到发抖" : "摸摸")
          : this.state === "touch" ? (info.zone === "face" ? "摸到脸了" : "摸到了")
            : this.state === "hover" ? "看着你的手"
              : this.state === "happy" ? "还想被摸" : "待机中"
    );
  }

  /* ---------------- 待机动作调度 ---------------- */
  nextIdle() {
    // 眨眼权重最高（真动物没事就眨眼），舔爪和哈欠偶尔来一次
    const pool = ["blink", "look", "blink", "lick", "look", "blink", "yawn"];
    let pick = pool[(Math.random() * pool.length) | 0];
    if (pick === this.idleAct && Math.random() < 0.5) pick = pool[(Math.random() * pool.length) | 0];
    this.idleAct = pick;
    this.idleDur = pick === "lick" ? 2.0 : pick === "yawn" ? 1.8 : 1.4;
    this.idleT = this.idleDur + rand(GEST.idleMin, GEST.idleMax);
  }

  /* ---------------- 手势动作入口 ---------------- */

  /* 张开手 → 原地完整转一圈，随后抖耳朵，一声短促叫声 */
  spin(now) {
    if (now - this.lastSpin < GEST.openCooldownMs) return false;
    if (this.act && this.act.name === "roll") return false;
    this.lastSpin = now;
    this.act = { name: "spin", t0: now, dur: GEST.spinSec * 1000 };
    this.events.push({ type: "voice", short: true });
    this.earShakeT = 0.35;   // 转完抖耳朵，在 updateAction 里接上
    return true;
  }

  /* 挥手 → 朝手势方向跑（四次交替踏步 + 前倾） */
  run(dir, now) {
    if (now - this.lastWave < GEST.waveCooldownMs) return false;
    this.lastWave = now;
    this.act = { name: "run", t0: now, dur: GEST.runSec * 1000, dir: dir > 0 ? 1 : -1, from: this.runOffset };
    return true;
  }

  /* 双手 → 在地上打滚 + 嘤嘤嘤 */
  roll(now) {
    this.lastRoll = now;
    this.act = { name: "roll", t0: now, dur: GEST.rollSec * 1000 };
    this.mood = clamp(this.mood + 0.12);
    this.dust = 1;
    for (let i = 0; i < 3; i++) {
      this.events.push({ type: "voice", soft: true, squeak: true, delay: 180 + i * 260 });
    }
    return true;
  }

  /* 轻点 → 短叫 + 歪头 */
  tapReact() {
    this.act = { name: "tilt", t0: this.now, dur: GEST.tiltSec * 1000 };
    this.mood = clamp(this.mood + 0.06);
    this.events.push({ type: "voice", short: true });
    this.headDY.kick(-0.5);
  }

  /* ---------------- 动作时间轴 ---------------- */
  updateAction(dt, now) {
    /* 抖耳朵：转圈结束后 0.35 秒 */
    if (this.earShakeT > 0) {
      this.earShakeT -= dt;
      this.pose.headRot += Math.sin(this.earShakeT * 90) * 0.045 * clamp(this.earShakeT / 0.35);
    }

    if (!this.act) {
      /* 跑完回中：慢慢走回原来的位置 */
      if (this.runOffset !== 0) {
        this.runOffset *= Math.max(0, 1 - dt * 2.2);
        if (Math.abs(this.runOffset) < 0.5) this.runOffset = 0;
      }
      this.pose.x += this.runOffset;
      this.dust = Math.max(0, this.dust - dt * 1.6);
      return;
    }

    const a = this.act;
    const u = clamp((now - a.t0) / a.dur);
    const p = this.pose;

    if (a.name === "spin") {
      /* 绕竖轴转一圈：用水平缩放 cos 模拟「转身」，比整体旋转更像真动物。
         纯 cos 在 90° 处会压成一条 1px 的线（看起来像卡死了），
         所以给宽度兜一个 22% 的下限，转过身时是「变窄 + 镜像」而不是消失。 */
      const e = easeInOutSine(u);
      const c = Math.cos(e * Math.PI * 2);
      p.sx *= (c < 0 ? -1 : 1) * Math.max(Math.abs(c), 0.22);
      // 转到侧面时（|sx| 小）稍微跳一下，重心有起伏
      p.y -= Math.abs(Math.sin(e * Math.PI * 2)) * this.dispH * 0.018;
      p.sy *= 1 + Math.sin(e * Math.PI * 2) * 0.012;
      p.headRot += Math.sin(e * Math.PI * 2) * 0.05;
    } else if (a.name === "run") {
      /* 朝手势方向跑：位移 + 交替踏步 + 前倾 + 上下颠 */
      const e = easeOutCubic(u);
      // 幅度同时受画布宽度限制，窄屏 / iframe 小窗里不会跑出边界
      const maxDrift = Math.min(this.dispH * 0.55, (this.W || 900) * 0.22);
      const travel = a.dir * maxDrift;
      this.runOffset = a.from + travel * e;
      p.x += this.runOffset;

      const stride = u * Math.PI * 2 * 4;          // 4 个步幅
      const stepAmp = 0.030;                      // 素材高度比例
      /* 内置 7 只带独立前爪层 → 左右交替抬起，是真的四条腿在蹬；
         用户复刻的宠物只有一张照片、拆不出四肢层，改用更强的整体起伏 +
         段落式前倾来读「在跑」（硬拆四肢会出现断腿/残影）。 */
      const hasPaws = this.cfg.pawMode !== false;
      if (hasPaws) {
        // 左爪在前半个周期抬起、右爪在后半个周期抬起：真正的交替
        p.pawL = -Math.max(0, Math.sin(stride)) * stepAmp;
        p.pawR = -Math.max(0, Math.sin(stride + Math.PI)) * stepAmp;
      }
      p.y -= Math.abs(Math.sin(stride)) * this.dispH * (hasPaws ? 0.022 : 0.034);
      p.rot += a.dir * 0.035 * (1 - u * 0.5);
      if (!hasPaws) {
        p.rot += a.dir * 0.013 * Math.sin(stride * 2);
        p.sy *= 1 + 0.016 * Math.sin(stride * 2);
      }
      p.headRot += a.dir * 0.03 + Math.sin(stride) * 0.02;
      p.headDY += 0.01 * Math.sin(stride + 0.7);
      p.sx *= 1 + 0.02 * Math.sin(stride * 2);
      this.dust = Math.min(1, this.dust + dt * 3);
      // 跑到一半叫一声
      if (!a.barked && u > 0.25) {
        a.barked = true;
        this.events.push({ type: "voice", soft: true });
      }
    } else if (a.name === "roll") {
      /* 打滚：整体翻一圈，同时左右蹭一下 */
      const e = easeInOutSine(u);
      const th = e * Math.PI * 2;
      p.rot += -th;
      p.x += Math.sin(u * Math.PI * 2) * this.dispH * 0.10;
      /* 绕身体中段转，翻到侧面 / 倒立时下半身会探到地面线以下（跑出画布）。
         这里按旋转角算出「最深点」，转多少就抬多少，全程都稳稳画在地上。 */
      const dip = 0.36 * Math.abs(Math.sin(th)) + 0.54 * Math.abs(Math.cos(th)) - 0.46;
      p.y -= Math.max(0, dip) * this.dispH;
      p.sy *= 1 - 0.05 * Math.sin(u * Math.PI);
      p.headRot += Math.sin(u * Math.PI * 2) * 0.10;
      this.dust = Math.max(this.dust, 1 - u * 0.4);
    } else if (a.name === "tilt") {
      /* 歪头：先歪过去（带回弹），停一下，再回来 */
      const k = u < 0.22 ? easeOutBack(u / 0.22) : u < 0.72 ? 1 : 1 - easeInOutSine((u - 0.72) / 0.28);
      p.headRot += 0.36 * k;
      p.headDX += 0.012 * k;
      p.headDY += 0.006 * k;
      p.sy *= 1 - 0.006 * k;
    }

    if (u >= 1) this.act = null;
    this.dust = Math.max(0, this.dust - dt * 0.9);
  }
}
