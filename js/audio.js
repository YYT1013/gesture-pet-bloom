/* ============================================================
 * audio.js —— 7 只宠物的叫声，全部 WebAudio 现场合成
 *
 * 为什么不用录音文件：
 *   · 零音频体积、零版权风险（可商用），iframe 嵌站也不会多几个请求；
 *   · 音高/时长/粗糙度能跟着动作实时变（跑动时短促、摸头时低沉）。
 *
 * 三个关键设计：
 *   1. 主总线挂了一个压缩器（DynamicsCompressor）—— 猫叫能量集中在中频、
 *      狗叫低频重，不压一下就会出现「猫叫刺耳、狗叫听不见」；
 *   2. 每种叫声有自己的峰值系数（PEAK），再经过压缩器，响度就标准化了；
 *   3. 配方完全由 voice.type 决定，见 config.js 的 PETS[].voice。
 *
 *   cat    喵：锯齿 + 双共振峰 + 6Hz 颤音，滑音先上后落（真实猫叫的走向）
 *   dog    汪：噪声爆音扫频 + 低频锯齿垫底（胸腔共鸣）
 *   pup    奶狗嗷呜：正弦为主、音高先扬后抑、起音柔
 *   squeak 嘤嘤嘤：1.5~2.2kHz 的短啾，30Hz 快速颤音、三连
 * ============================================================ */

const PEAK = { cat: 0.50, dog: 0.58, pup: 0.46, squeak: 0.34 };

export class Sound {
  constructor() {
    this.ctx = null;
    this.vol = 0.72;
    this.muted = false;
    this.lastVoice = -1e9;
    this._noise = null;
  }

  /* 必须在用户手势里调用一次，浏览器才允许出声 */
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      // 主总线：压缩器 → 音量 → 扬声器
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -18;
      this.comp.knee.value = 14;
      this.comp.ratio.value = 4;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.22;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.vol;
      this.comp.connect(this.master);
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  setVolume(v) {
    this.vol = v;
    if (this.master) this.master.gain.value = v;
  }

  get noise() {
    if (!this._noise) {
      const len = Math.floor(this.ctx.sampleRate * 0.7);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._noise = buf;
    }
    return this._noise;
  }

  /* 统一入口
   *   cfg   config.js 里的 PETS 项（用到 cfg.voice）
   *   opts  soft 轻一点（摸久了自动叫）
   *         short 短促（轻点 / 转圈）
   *         low   低吟（摸头时压低音高）
   *         squeak 强制嘤嘤（打滚时的连续小声）  */
  voice(cfg, opts = {}) {
    if (this.muted) return null;
    const ctx = this.ensure();
    if (!ctx) return null;
    // 180ms 内只响一次，防止抚摸时刷屏
    if (performance.now() - this.lastVoice < 170) return null;
    this.lastVoice = performance.now();

    const v = (cfg && cfg.voice) || { type: "cat", pitch: 480, rate: 1, rough: 0.2 };
    const type = opts.squeak ? "squeak" : v.type;
    const jitter = 0.95 + Math.random() * 0.1;          // 每声略有不同，避免机械感
    const p = v.pitch * jitter * (opts.low || 1);
    const rate = v.rate || 1;
    const amp = PEAK[type] * (opts.soft ? 0.55 : 1) * (opts.short ? 0.8 : 1);
    const t = ctx.currentTime + 0.005;

    if (type === "cat") this.meow(t, p, (opts.short ? 0.26 : 0.46) / rate, amp, v.rough);
    else if (type === "dog") this.bark(t, p, (opts.short ? 0.11 : 0.17) / rate, amp, v.rough);
    else if (type === "pup") this.whine(t, p, (opts.short ? 0.30 : 0.52) / rate, amp);
    else this.chirp(t, p, amp);
    return true;
  }

  /* ---------- 猫：喵 ---------- */
  meow(t, pitch, dur, gain, rough = 0.15) {
    const c = this.ctx;
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(gain, t + 0.030);
    out.gain.exponentialRampToValueAtTime(gain * 0.72, t + dur * 0.62);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    out.connect(this.comp);

    // 共振峰随基频一起缩放，换品种只是「换个音高」，元音还是猫的「喵」
    const k = pitch / 500;
    const f1 = c.createBiquadFilter();
    f1.type = "bandpass"; f1.Q.value = 3.6;
    f1.frequency.setValueAtTime(700 * k, t + 0.02);
    f1.frequency.linearRampToValueAtTime(1150 * k, t + dur * 0.5);
    f1.frequency.linearRampToValueAtTime(720 * k, t + dur);
    f1.connect(out);

    const f2 = c.createBiquadFilter();
    f2.type = "bandpass"; f2.Q.value = 6;
    f2.frequency.setValueAtTime(2000 * k, t);
    const g2 = c.createGain(); g2.gain.value = 0.28 + rough * 0.3;
    f2.connect(g2); g2.connect(out);

    const o1 = c.createOscillator();
    o1.type = "sawtooth";
    o1.frequency.setValueAtTime(pitch * 0.86, t + 0.02);
    o1.frequency.exponentialRampToValueAtTime(pitch * 1.22, t + dur * 0.30);
    o1.frequency.exponentialRampToValueAtTime(pitch * 0.80, t + dur);
    o1.connect(f1); o1.connect(f2);

    const o2 = c.createOscillator();
    o2.type = "triangle";
    o2.frequency.setValueAtTime(pitch * 1.7, t + 0.02);
    o2.frequency.exponentialRampToValueAtTime(pitch * 2.2, t + dur * 0.32);
    o2.frequency.exponentialRampToValueAtTime(pitch * 1.5, t + dur);
    const g3 = c.createGain(); g3.gain.value = 0.16;
    o2.connect(g3); g3.connect(out);

    // 6Hz 颤音：猫叫的「抖音」，粗糙度越大抖得越明显
    const lfo = c.createOscillator(); lfo.frequency.value = 6.0 + rough * 4;
    const lfoG = c.createGain(); lfoG.gain.value = pitch * 0.02;
    lfo.connect(lfoG); lfoG.connect(o1.frequency);

    [o1, o2, lfo].forEach((o) => { o.start(t); o.stop(t + dur + 0.06); });
  }

  /* ---------- 狗：汪 ---------- */
  bark(t, pitch, dur, gain, rough = 0.5) {
    const c = this.ctx;
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(gain, t + 0.008);   // 起音极快 = 「汪」的爆
    out.gain.exponentialRampToValueAtTime(gain * 0.3, t + dur * 0.55);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    out.connect(this.comp);

    const n = c.createBufferSource();
    n.buffer = this.noise;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass"; bp.Q.value = 1.5 + rough;
    bp.frequency.setValueAtTime(1600 * (pitch / 260), t);
    bp.frequency.exponentialRampToValueAtTime(380 * (pitch / 260), t + dur);
    const ng = c.createGain(); ng.gain.value = 1;
    n.connect(bp); bp.connect(ng); ng.connect(out);

    const o = c.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(pitch * 0.72, t);
    o.frequency.exponentialRampToValueAtTime(pitch * 0.38, t + dur);
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 820;
    const og = c.createGain(); og.gain.value = 0.6;
    o.connect(lp); lp.connect(og); og.connect(out);

    n.start(t); n.stop(t + dur + 0.05);
    o.start(t); o.stop(t + dur + 0.05);
  }

  /* ---------- 奶狗：嗷呜（音高先扬后抑，尾巴带颤） ---------- */
  whine(t, pitch, dur, gain) {
    const c = this.ctx;
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.linearRampToValueAtTime(gain, t + 0.06);          // 柔起音
    out.gain.linearRampToValueAtTime(gain * 0.8, t + dur * 0.5);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    out.connect(this.comp);

    const f = c.createBiquadFilter();
    f.type = "bandpass"; f.Q.value = 2.4;
    f.frequency.setValueAtTime(620, t);
    f.frequency.linearRampToValueAtTime(980, t + dur * 0.42);
    f.frequency.linearRampToValueAtTime(560, t + dur);
    f.connect(out);

    const o = c.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(pitch * 0.9, t);
    o.frequency.exponentialRampToValueAtTime(pitch * 1.5, t + dur * 0.35);
    o.frequency.exponentialRampToValueAtTime(pitch * 0.85, t + dur);
    o.connect(f);

    const o2 = c.createOscillator();   // 加一层八度让声音有「奶味」
    o2.type = "sine";
    o2.frequency.setValueAtTime(pitch * 1.8, t);
    o2.frequency.exponentialRampToValueAtTime(pitch * 2.6, t + dur * 0.35);
    o2.frequency.exponentialRampToValueAtTime(pitch * 1.6, t + dur);
    const g2 = c.createGain(); g2.gain.value = 0.22;
    o2.connect(g2); g2.connect(out);

    const lfo = c.createOscillator(); lfo.frequency.value = 7.5;
    const lg = c.createGain(); lg.gain.value = pitch * 0.03;
    lfo.connect(lg); lg.connect(o.frequency);

    [o, o2, lfo].forEach((x) => { x.start(t); x.stop(t + dur + 0.06); });
  }

  /* ---------- 仓鼠 / 小动物：嘤嘤嘤 ----------
   * 真实仓鼠的叫声是 1.5~3kHz 的短促啾鸣，连着 3~4 声，
   * 每声都带 30Hz 的快速颤音 —— 这就是「嘤」的质感。 */
  chirp(t, pitch, gain) {
    const c = this.ctx;
    const n = 3;
    for (let i = 0; i < n; i++) {
      const at = t + i * 0.075;
      const dur = 0.062;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(gain * (i === 0 ? 1 : 0.78), at + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      g.connect(this.comp);

      const o = c.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(pitch * (0.92 + i * 0.05), at);
      o.frequency.exponentialRampToValueAtTime(pitch * (1.35 + i * 0.04), at + dur * 0.55);
      o.frequency.exponentialRampToValueAtTime(pitch * 1.05, at + dur);

      // 30Hz 大幅颤音 = 「嘤嘤」的抖动感
      const trem = c.createOscillator(); trem.frequency.value = 34;
      const tg = c.createGain(); tg.gain.value = 0.55;
      const vca = c.createGain(); vca.gain.value = 0.5;
      trem.connect(tg); tg.connect(vca.gain);

      o.connect(vca); vca.connect(g);
      o.start(at); o.stop(at + dur + 0.02);
      trem.start(at); trem.stop(at + dur + 0.02);
    }
  }

  /* ---------- 呼噜 / 低鸣：抚摸时的背景音 ---------- */
  purr(cfg) {
    if (this.muted) return;
    const c = this.ensure();
    if (!c) return;
    const t = c.currentTime;
    const cat = cfg && cfg.kind === "cat";
    const dur = cat ? 0.9 : 0.55;
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.linearRampToValueAtTime(cat ? 0.11 : 0.06, t + 0.09);
    out.gain.linearRampToValueAtTime(0.0001, t + dur);
    out.connect(this.comp);

    const o = c.createOscillator();
    o.type = "triangle";
    o.frequency.value = cat ? 62 : 44;
    const trem = c.createOscillator();
    trem.frequency.value = cat ? 27 : 17;
    const tg = c.createGain(); tg.gain.value = 0.5;
    const vca = c.createGain(); vca.gain.value = 0.55;
    trem.connect(tg); tg.connect(vca.gain);

    const n = c.createBufferSource(); n.buffer = this.noise;
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 420;
    const ng = c.createGain(); ng.gain.value = 0.18;
    n.connect(lp); lp.connect(ng);

    o.connect(vca); ng.connect(vca); vca.connect(out);
    o.start(t); o.stop(t + dur);
    trem.start(t); trem.stop(t + dur);
    n.start(t); n.stop(t + dur);
  }
}
