#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build_pets.py —— 把用户提供的 7 张实拍宠物照片做成「照片木偶」素材

为什么不是序列帧图集：
    7 只 × 多帧的写实照片图集少说 5~15MB，嵌进网站加载会很慢；
    而写实照片的价值在于「这张脸是真的」，头部/身体分开做木偶，
    一个品种只需要 2 张 webp（头 + 身），合计 0.6MB 左右，
    动作靠变换插值，比逐帧切换顺滑得多，也不会有换帧时的形体跳变。

产出：
    assets/pets/<id>.webp          整只（含头身，兜底用）
    assets/pets/<id>_head.webp     头部块（以颈部为枢轴）
    assets/pets/<id>_body.webp     身体块
    assets/pets/<id>_pawL.webp     左前爪补丁（可选）
    assets/pets/<id>_pawR.webp     右前爪补丁（可选）
    assets/pets/meta.json          每只的几何信息（颈部高度、枢轴、缩放）

用法：
    python tools/build_pets.py            # 默认读 refs/ 下的参考图
"""
import os, sys, json, glob
import numpy as np
import cv2
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "pets")
REFS = os.path.join(ROOT, "refs")
TARGET_H = 560          # 素材高度（够 1080p 全屏用了，再大就是浪费带宽）
FEATHER = 5             # 头/身接缝的羽化像素

# 参考图 → 品种 id，顺序与用户上传的 7 张图一一对应
REF_ORDER = [
    ("golden",  "golden.jpg"),    # 金毛
    ("shiba",   "shiba.jpg"),     # 柴犬
    ("corgi",   "corgi.jpg"),     # 柯基
    ("orange",  "orange.jpg"),    # 橘猫（全身坐姿）
    ("ragdoll", "ragdoll.jpg"),   # 布偶
    ("british", "british.jpg"),   # 英短
    ("hamster", "hamster.jpg"),   # 仓鼠
]

# 这几张是「只有上半身、底部被画面切断」的特写，底边要软过渡到地面。
# 现在 7 张都是完整全身照，这里留空；将来换了特写图再往里加。
PORTRAIT_CUT = set()

# 头部切线（占素材高度的比例）。为什么不自动算：
#   宠物坐着时脖子那一段的轮廓宽度并不收窄（被下面的胸口撑着），
#   仓鼠更是整个一个球、压根没有脖子，任何自动判据都会切到脸上。
#   这里是照刻度图逐张确认过的「下巴以下、胸口以上」的位置。
HEAD_CUT = {
    "golden": 0.43, "shiba": 0.41, "corgi": 0.41, "orange": 0.34,
    "ragdoll": 0.38, "british": 0.38, "hamster": 0.47,
}

# 前爪补丁框 [x0, y0, x1, y1]（相对整只素材的宽高比例）。
# 用途：跑动时两只前爪交替抬起。补丁是叠在「完整身体」上面的，
# 所以抬起时不会在腿根处露洞。
PAW_BOX = {
    "golden":  {"L": [0.18, 0.84, 0.50, 1.0], "R": [0.52, 0.84, 0.84, 1.0]},
    "shiba":   {"L": [0.16, 0.84, 0.50, 1.0], "R": [0.52, 0.84, 0.86, 1.0]},
    "corgi":   {"L": [0.04, 0.80, 0.42, 1.0], "R": [0.58, 0.80, 0.96, 1.0]},
    "ragdoll": {"L": [0.20, 0.86, 0.50, 1.0], "R": [0.52, 0.86, 0.82, 1.0]},
    "british": {"L": [0.22, 0.85, 0.50, 1.0], "R": [0.52, 0.85, 0.80, 1.0]},
    "hamster": {"L": [0.28, 0.70, 0.50, 0.92], "R": [0.52, 0.70, 0.74, 0.92]},
    "orange":  {"L": [0.24, 0.86, 0.50, 1.0], "R": [0.52, 0.86, 0.78, 1.0]},
}


# ---------------------------------------------------------------- 基础工具
def trim_letterbox(im):
    """手机截图上下有纯黑条，先按行/列的「近黑且均匀」判定裁掉。"""
    a = np.asarray(im.convert("RGB")).astype(np.float32)
    H, W, _ = a.shape
    row_dark = (a.mean(axis=(1, 2)) < 24) & (a.std(axis=(1, 2)) < 12)
    col_dark = (a.mean(axis=(0, 2)) < 24) & (a.std(axis=(0, 2)) < 12)
    top = 0
    while top < H - 1 and row_dark[top]:
        top += 1
    bot = H - 1
    while bot > top and row_dark[bot]:
        bot -= 1
    left = 0
    while left < W - 1 and col_dark[left]:
        left += 1
    right = W - 1
    while right > left and col_dark[right]:
        right -= 1
    # 留 2px 余量，避免把图边缘的暗色毛发裁掉
    box = (max(0, left - 2), max(0, top - 2), min(W, right + 3), min(H, bot + 3))
    return im.crop(box)


def alpha_grabcut(im):
    """无 rembg 时的兜底抠图：GrabCut + 边缘细化。

    原图动辄 1200×2500，直接全分辨率跑 GrabCut 要一两分钟；
    先缩到 720 长边再跑，最后把 mask 双线性放大回去 ——
    顺带得到一圈软边，比硬二值更适合毛发。
    """
    rgb = cv2.cvtColor(np.asarray(im.convert("RGB")), cv2.COLOR_RGB2BGR)
    H, W = rgb.shape[:2]
    s = min(1.0, 720.0 / max(H, W))
    if s < 1.0:
        small = cv2.resize(rgb, (max(8, int(W * s)), max(8, int(H * s))), interpolation=cv2.INTER_AREA)
    else:
        small = rgb
    h, w = small.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    m = int(min(h, w) * 0.03)
    rect = (m, m, w - 2 * m, h - 2 * m)
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    cv2.grabCut(small, mask, rect, bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
    a = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    a = cv2.morphologyEx(a, cv2.MORPH_CLOSE, k, iterations=2)
    a = cv2.morphologyEx(a, cv2.MORPH_OPEN, k, iterations=1)
    if (h, w) != (H, W):
        a = cv2.resize(a, (W, H), interpolation=cv2.INTER_LINEAR)
    return a


def alpha_rembg(im):
    """u2net 抠图，毛发边缘明显更准。"""
    from rembg import remove, new_session
    sess = new_session("u2net")
    m = remove(im.convert("RGB"), session=sess, only_mask=True, post_process_mask=True)
    return np.asarray(m.convert("L"))


def refine(a):
    """只留最大的连通块（去掉截图里的 "1/5"、水印字、文字标题），再补洞。"""
    n, lab, stats, _ = cv2.connectedComponentsWithStats((a > 127).astype(np.uint8), 8)
    if n <= 1:
        return a
    idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    keep = (lab == idx).astype(np.uint8)
    # 补洞：从外部灌水，灌不到的地方就是内部
    ff = keep.copy()
    h, w = ff.shape
    ff2 = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(ff, ff2, (0, 0), 1)
    holes = (ff == 0).astype(np.uint8)
    keep = np.clip(keep + holes, 0, 1)
    keep = cv2.morphologyEx(keep, cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)), iterations=2)
    out = (keep * 255).astype(np.uint8)
    # 边缘轻微羽化，贴到渐变背景上不会有一圈白边
    out = cv2.GaussianBlur(out, (3, 3), 0.6)
    return out


def find_neck(alpha):
    """找脖子那一行。

    不能用「行宽最小」：宠物坐着时，脖子那一行的行宽其实等于它所叠着的胸部宽度，
    根本不会变窄，结果会误判到脸上。换成距离变换：脖子是头部圆和身体圆之间的
    「鞍点」，内切圆半径最小 —— 对坐着、站着、只有上半身的特写都成立。
    """
    H, W = alpha.shape
    mask = (alpha > 127).astype(np.uint8)
    D = cv2.distanceTransform(mask, cv2.DIST_L2, 5)

    # 只在躯干中线附近找，避开两侧耳朵和腿
    xs = np.where(mask.any(axis=0))[0]
    cx = int((xs.min() + xs.max()) / 2)
    band = max(4, int(W * 0.10))
    col = D[:, max(0, cx - band): min(W, cx + band)]
    prof = col.max(axis=1)          # 每一行在中心带内的最大内切半径

    lo, hi = int(H * 0.28), int(H * 0.66)
    seg = prof[lo:hi]
    if len(seg) < 5:
        return int(H * 0.45)
    # 平滑一下，避免毛发边缘的小尖刺造成假极小
    k = max(3, (hi - lo) // 20 * 2 + 1)
    seg = cv2.GaussianBlur(seg.reshape(-1, 1), (1, k), 0).ravel()

    best, bestY = 1e9, lo + int(np.argmin(seg))
    for i in range(2, len(seg) - 2):
        y = lo + i
        if seg[i] <= seg[i - 2] and seg[i] <= seg[i + 2]:
            # 鞍点应当明显低于头心（上方 8% 处）的半径
            up = float(prof[max(0, y - int(H * 0.12)): y - int(H * 0.04) + 1].max())
            if seg[i] < up * 0.92 and seg[i] < best:
                best, bestY = seg[i], y
    return int(bestY)


def ground_fade(arr, start=0.94):
    """把底边残留的「棚拍地板影子」淡掉。

    抠图模型经常把宠物脚下那片被拍亮的地板当成主体留着 ——
    在浅色页面上看不出来，一旦贴到木桌上就是一块灰色抹布。
    宠物脚底本来就踩在地上，这里做 6% 高度的软过渡：
    地板影消失，脚爪只是轻微压进桌面，看起来更像真的站着。
    """
    a = arr[..., 3].astype(np.float32) / 255.0
    h = a.shape[0]
    y0 = int(h * start)
    n = max(1, h - y0)
    ramp = np.linspace(1.0, 0.0, n).reshape(-1, 1)
    a[y0:] *= ramp
    arr[..., 3] = (np.clip(a, 0, 1) * 255).astype(np.uint8)
    return arr


def floor_blob_ratio(arr):
    """底边宽度 / 身体宽度。明显大于 1 说明图里带着一片地板影。"""
    m = arr[..., 3] > 128
    h = m.shape[0]
    rows = m.sum(axis=1).astype(np.float32)
    body = np.median(rows[int(h * 0.62):int(h * 0.80)])
    base = rows[int(h * 0.985):].max()
    return float(base / max(1.0, body))


def feather_edge(alpha, top_fade=None, bottom_fade=None):
    a = alpha.astype(np.float32) / 255.0
    h = a.shape[0]
    if top_fade:
        n = min(top_fade, h)
        a[:n] *= np.linspace(0, 1, n).reshape(-1, 1)
    if bottom_fade:
        n = min(bottom_fade, h)
        a[h - n:] *= np.linspace(1, 0, n).reshape(-1, 1)
    return (np.clip(a, 0, 1) * 255).astype(np.uint8)


def rgba_of(im, alpha):
    rgb = np.asarray(im.convert("RGB"))
    return np.dstack([rgb, alpha])


def save_webp(arr, path, q=86):
    Image.fromarray(arr, "RGBA").save(path, "WEBP", quality=q, method=6, exact=True)
    return os.path.getsize(path)


def crop_to_alpha(arr):
    a = arr[..., 3]
    ys, xs = np.where(a > 8)
    if len(ys) == 0:
        return arr, (0, 0)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    return arr[y0:y1, x0:x1], (x0, y0)


# ---------------------------------------------------------------- 主流程
def main():
    os.makedirs(OUT, exist_ok=True)
    has_rembg = False
    try:
        import rembg  # noqa
        has_rembg = True
    except Exception:
        print("!! rembg 不可用，退回 GrabCut（毛发边缘会糙一些）")
    print("cutout engine:", "rembg/u2net" if has_rembg else "grabcut")

    meta = {}
    meta_path = os.path.join(OUT, "meta.json")
    # 只重建某几只用 `python tools/build_pets.py orange`，其余条目原样保留
    only = set(sys.argv[1:])
    if only and os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)

    for pid, fname in REF_ORDER:
        if only and pid not in only:
            continue
        src = os.path.join(REFS, fname)
        if not os.path.exists(src):
            print("!! 找不到参考图", pid, src)
            continue
        im = trim_letterbox(Image.open(src))
        a = alpha_rembg(im) if has_rembg else alpha_grabcut(im)
        a = refine(a)

        arr = rgba_of(im, a)
        arr, _ = crop_to_alpha(arr)
        # 底边地板影：测一下「底部宽度 / 身体宽度」，明显偏宽就淡掉
        ratio = floor_blob_ratio(arr)
        fade_from = 0.925 if ratio > 1.15 else 0.972
        arr = ground_fade(arr, start=fade_from)
        arr, _ = crop_to_alpha(arr)
        # 特写图没有脚：底边做软过渡，配合地面的阴影看起来才不像「被切断」
        if pid in PORTRAIT_CUT:
            hs = arr.shape[0]
            n = int(hs * 0.10)
            ramp = np.linspace(1, 0, n).reshape(-1, 1)
            arr[hs - n:, 3] = np.clip(arr[hs - n:, 3].astype(np.float32) * ramp, 0, 255).astype(np.uint8)
        # 统一高度
        h0, w0 = arr.shape[:2]
        scale = TARGET_H / h0
        arr = np.asarray(Image.fromarray(arr, "RGBA")
                         .resize((max(1, round(w0 * scale)), TARGET_H), Image.LANCZOS))
        H, W = arr.shape[:2]

        # 头身切线：默认查表（人工确认过），查不到才用自动判据
        if pid in HEAD_CUT:
            neck = int(round(HEAD_CUT[pid] * H))
        else:
            neck = find_neck(arr[..., 3])
        neck = max(int(H * 0.25), min(int(H * 0.65), neck))

        # ---- 整只 ----
        size_full = save_webp(arr, os.path.join(OUT, f"{pid}.webp"))

        # ---- 头：颈线以上 + 底部羽化 ----
        head = arr[0: min(H, neck + FEATHER)].copy()
        head[..., 3] = feather_edge(head[..., 3], bottom_fade=FEATHER)
        head, (hx, hy) = crop_to_alpha(head)
        hh, hw = head.shape[:2]
        size_head = save_webp(head, os.path.join(OUT, f"{pid}_head.webp"))

        # ---- 身体：直接用整张图 ----
        # 切一条横线当身体，会在肩部留下一道直线接缝（头盖不住的侧边会露出来）。
        # 改成整张图打底、头再叠上去：静止时两张图的像素完全重合，看不出拼接；
        # 头动的时候，被让出来的地方显示的是它自己的原像素（等于毛发被压实），
        # 不会像挖洞那样露出背景。
        body_top = 0

        # ---- 前爪补丁（跑动时交替抬起） ----
        paws = {}
        for side in ("L", "R"):
            box = PAW_BOX.get(pid, {}).get(side)
            if not box:
                continue
            x0 = int(round(box[0] * W)); y0 = int(round(box[1] * H))
            x1 = int(round(box[2] * W)); y1 = int(round(box[3] * H))
            x0, x1 = max(0, x0), min(W, x1)
            y0, y1 = max(0, y0), min(H, y1)
            if x1 - x0 < 8 or y1 - y0 < 8:
                continue
            patch = arr[y0:y1, x0:x1].copy()
            patch[..., 3] = feather_edge(patch[..., 3], top_fade=8)
            patch, (pxx, pyy) = crop_to_alpha(patch)
            save_webp(patch, os.path.join(OUT, f"{pid}_paw{side}.webp"))
            paws[side] = {
                "w": int(patch.shape[1]), "h": int(patch.shape[0]),
                "ox": round(pxx + x0 - W / 2, 1),
                "oy": round(pyy + y0 - H, 1),
            }

        # 所有几何量都以「整只素材的像素」为单位，渲染时统一乘 k = 显示高度 / H
        meta[pid] = {
            "full": {"w": W, "h": H},
            "neckY": round(neck / H, 4),
            "head": {
                "w": int(hw), "h": int(hh),
                "ox": round(hx - W / 2, 1),        # 头部小图左上角，相对整只底边中心
                "oy": round(hy - H, 1),
                "px": round(W / 2 - hx, 1),        # 枢轴（颈部）在头部小图里的位置
                "py": round(neck - hy, 1),
            },
            "body": {"w": W, "h": H, "ox": round(-W / 2, 1), "oy": round(-H, 1)},
            "paws": paws,
            "kb": {"full": round(size_full / 1024, 1), "head": round(size_head / 1024, 1)},
        }
        print(f"{pid:9s} {W}x{H} neck={neck}({neck/H:.2f})  "
              f"full {size_full/1024:.0f}K head {size_head/1024:.0f}K paws={''.join(sorted(paws))}")

        # 预览：贴到米色底上，划线看切线
        prev = np.zeros((H, W, 3), np.uint8)
        prev[:] = (246, 240, 232)
        al = arr[..., 3:4].astype(np.float32) / 255.0
        prev = (arr[..., :3].astype(np.float32) * al + prev * (1 - al)).astype(np.uint8)
        cv2.line(prev, (0, neck), (W, neck), (60, 60, 220), 2)
        for side, p in paws.items():
            cv2.rectangle(prev, (int(p["ox"] + W / 2 - p["w"] / 2), int(p["oy"] + H)),
                          (int(p["ox"] + W / 2 + p["w"] / 2), int(p["oy"] + H + p["h"])),
                          (40, 170, 90), 2)
        Image.fromarray(prev).save(os.path.join(OUT, f"_preview_{pid}.png"))

    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1,
                  default=lambda o: o.item() if hasattr(o, "item") else o)
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT)
                if f.endswith(".webp"))
    print("total webp: %.2f MB" % (total / 1048576))


if __name__ == "__main__":
    main()
