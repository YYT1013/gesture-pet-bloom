/* ============================================================
 * config.js —— 全部可调参数集中在这里（改行为先改这张表）
 *
 * 1. PETS   7 只宠物的素材几何 + 叫声配方
 * 2. TOUCH  触摸判定阈值（灵敏度滑块就是在这两端之间取值）
 * 3. GEST   手势识别阈值（张开手 / 挥手 / 双手）
 * 4. LM     MediaPipe 21 点索引 + 骨架连线
 *
 * 关于素材几何：
 *   每只宠物是「用户实拍图抠出来的照片木偶」，不是画的矢量图。
 *   aspect = 素材宽/高，neckY = 颈部切线在素材高度上的比例，
 *   这两个值由 tools/build_pets.py 生成，写在 assets/pets/meta.json 里。
 *   换照片 → 重跑脚本 → 把新数值回填到下面的对应条目即可。
 * ============================================================ */

export const PETS = [
  {
    id: "orange", tint: "#e8913c", name: "橘猫", full: "中华田园橘猫",
    kind: "cat", aspect: 0.5464, neckY: 0.3393, size: 0.99,
    voice: { type: "cat", pitch: 500, rate: 1.0, rough: 0.16 },
    desc: "圆脸大眼，慢热但很黏人",
  },
  {
    id: "ragdoll", tint: "#d9cabd", name: "布偶", full: "布偶猫",
    kind: "cat", aspect: 0.6411, neckY: 0.3804, size: 1.0,
    voice: { type: "cat", pitch: 440, rate: 0.9, rough: 0.1 },
    desc: "被摸就软，叫起来细细的",
  },
  {
    id: "british", tint: "#8d949c", name: "英短", full: "英国短毛蓝白猫",
    kind: "cat", aspect: 0.4946, neckY: 0.3804, size: 0.94,
    voice: { type: "cat", pitch: 380, rate: 0.84, rough: 0.2 },
    desc: "蓝白配色，坐姿最端正",
  },
  {
    id: "shiba", tint: "#d98b3a", name: "柴犬", full: "柴犬",
    kind: "dog", aspect: 0.5804, neckY: 0.4107, size: 0.98,
    voice: { type: "dog", pitch: 250, rate: 1.05, rough: 0.5 },
    desc: "笑得最开心的一只，摸头会低头",
  },
  {
    id: "corgi", tint: "#e8a24a", name: "柯基", full: "威尔士柯基犬",
    kind: "dog", aspect: 0.7554, neckY: 0.4107, size: 0.92,
    voice: { type: "dog", pitch: 310, rate: 1.22, rough: 0.42 },
    desc: "小短腿，跑起来最欢",
  },
  {
    id: "golden", tint: "#e6c07a", name: "金毛", full: "金毛寻回犬",
    kind: "dog", aspect: 0.5679, neckY: 0.4304, size: 1.06,
    voice: { type: "pup", pitch: 270, rate: 0.95, rough: 0.3 },
    desc: "奶金色小奶狗，被摸会整个塌下来",
  },
  {
    id: "hamster", tint: "#d9b183", name: "仓鼠", full: "金丝熊仓鼠",
    kind: "hamster", aspect: 0.7304, neckY: 0.4696, size: 0.74,
    voice: { type: "squeak", pitch: 1500, rate: 1.0, rough: 0.03 },
    desc: "整个就是个球，叫起来嘤嘤嘤",
  },
];

/* ---------------- 触摸判定 ----------------
 * 单位说明：所有距离都换算成「体长」——宠物显示高度 = 1.0。
 * 所以下面的数值和屏幕分辨率、宠物大小都无关。 */
export const TOUCH = {
  // 指尖落在体表多近算「摸到」。数值越大越容易摸到
  sensMin: 0.030,
  sensMax: 0.105,
  sensDefault: 0.055,
  // 悬浮反应的距离倍数（在该倍数内，宠物会看着你的手）
  hoverBand: 2.4,
  // 抚摸判定：0.6 秒内累计刷过 0.22 个体长就算「在摸」，手停下自然退回「摸到」
  brushWindow: 600,
  brushLength: 0.22,
  // 轻点判定：接触时间 < 220ms 且几乎没位移
  tapMs: 220,
  tapMove: 0.055,
  // 双手同时接触持续多久才算「双手撸」
  twoHandMs: 240,
};

/* ---------------- 手势识别 ---------------- */
export const GEST = {
  /* 张开五指：跨度够大 + 至少 4 指伸直 + 持续 holdMs 才成立（防抖） */
  openSpread: 0.58,
  openFingers: 4,
  openHoldMs: 150,
  openCooldownMs: 2800,

  /* 挥手：沿用原项目 450ms / 16% 画面宽 的判定 */
  waveMs: 450,
  waveDist: 0.16,
  waveCooldownMs: 950,

  /* 各动作时长（秒），配缓动用 */
  spinSec: 1.6,      // 张开手 → 原地转一圈
  runSec: 1.4,       // 挥手 → 朝手势方向跑
  rollSec: 2.4,      // 双手 → 打滚
  tiltSec: 1.15,     // 轻点 → 歪头
  downSec: 0.45,     // 摸头 → 低头（进入时长）

  /* 待机动作循环间隔（秒） */
  idleMin: 3.4,
  idleMax: 7.0,
};

/* ---------------- 关键点索引（MediaPipe 手部 21 点） ---------------- */
export const LM = {
  wrist: 0, thumbTip: 4, indexTip: 8, middleTip: 12, ringTip: 16, pinkyTip: 20,
  thumbIP: 3, indexPIP: 6, middlePIP: 10, ringPIP: 14, pinkyPIP: 18,
  indexMCP: 5, middleMCP: 9, ringMCP: 13, pinkyMCP: 17,
};

// 骨架连线（画关键点用）
export const HAND_LINKS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];
