#!/usr/bin/env python3
"""
Blackbar — "Blur isn't redaction."

The filters here are real. The blur is a real Gaussian, the pixelation is a real
downsample-and-nearest-neighbour, and the numbers quoted on screen are measured
from those outputs at build time rather than written by hand:

    blur r=5      83 distinct shades survive
    pixelate b=9  58
    black bar      1

The closing beat swaps the value underneath. The blur and the pixelation both
visibly change, because both are functions of the content. The black bar does
not, because there is no content left. That is the whole argument, shown
instead of asserted.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np
import math, os

W, H, FPS, SS = 1024, 576, 18, 3

GRAPHITE = (28, 27, 25)
LINE = (58, 54, 46)
BONE = (237, 233, 224)
MUTE = (142, 138, 126)
DIM = (105, 102, 94)
SIGNAL = (242, 193, 78)
SAFE = (143, 185, 150)
RED = (206, 108, 94)

GF = "/usr/share/fonts/truetype/google-fonts/"
DJ = "/usr/share/fonts/truetype/dejavu/"
POP_M, POP_L = GF + "Poppins-Medium.ttf", GF + "Poppins-Light.ttf"
MONO = DJ + "DejaVuSansMono.ttf"

CARD_A = "4539 1488 0343 6467"
CARD_B = "4716 2201 9384 5573"
SW, SH = 396, 44


# ------------------------------------------------------------------ easing
def clamp(v, lo=0.0, hi=1.0): return max(lo, min(hi, v))
def smooth(t): t = clamp(t); return t * t * (3 - 2 * t)
def soft_out(t): return 1 - pow(1 - clamp(t), 4)
def back_out(t, s=1.7): t = clamp(t) - 1; return t * t * ((s + 1) * t + s) + 1
def seg(now, start, dur): return 1.0 if dur <= 0 else clamp((now - start) / dur)
def window(now, start, end, fade=0.40):
    if now < start or now > end: return 0.0
    return min(smooth((now - start) / fade), smooth((end - now) / fade))
def mix(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


# ------------------------------------------------------------------ treatments
_strip_cache = {}

def strip(text):
    if text in _strip_cache: return _strip_cache[text]
    im = Image.new("RGB", (SW, SH), (255, 255, 255))
    ImageDraw.Draw(im).text((12, 12), text, font=ImageFont.truetype(MONO, 21), fill=(26, 31, 39))
    _strip_cache[text] = im
    return im

def blurred(text, radius):
    return strip(text) if radius < 0.15 else strip(text).filter(ImageFilter.GaussianBlur(radius))

def pixelated(text, block):
    im = strip(text)
    if block < 2: return im
    b = int(block)
    return im.resize((max(1, SW // b), max(1, SH // b)), Image.BILINEAR).resize((SW, SH), Image.NEAREST)

def shades(im):
    return len(np.unique(np.asarray(im.convert("L"))))

SHADES_ORIG = shades(strip(CARD_A))
SHADES_BLUR = shades(blurred(CARD_A, 5))
SHADES_PIX = shades(pixelated(CARD_A, 9))

# Soft drop shadow, rendered once. White strips floating flat on graphite look
# pasted on; a little depth makes them read as objects sitting on a surface.
def _shadow(w, h):
    pad = 18
    sh = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rectangle([pad, pad + 3, pad + w, pad + h + 3], fill=(0, 0, 0, 150))
    return sh.filter(ImageFilter.GaussianBlur(4)), pad

SHADOW, SHADOW_PAD = _shadow(396, 44)


# ------------------------------------------------------------------ sprites
_cache = {}

def sprite(text, path, size, color, track=0.0):
    key = (text, path, round(size, 2), color, track)
    if key in _cache: return _cache[key]
    font = ImageFont.truetype(path, max(4, int(size * SS)))
    pad = int(size * SS)
    tmp = Image.new("RGBA", (int(len(text) * size * SS * 1.5) + pad * 2, int(size * SS * 2.6)), (0, 0, 0, 0))
    d = ImageDraw.Draw(tmp)
    x = pad
    for ch in text:
        d.text((x, pad // 2), ch, font=font, fill=color + (255,))
        x += d.textlength(ch, font=font) + track * SS
    bb = tmp.getbbox()
    img = (tmp.crop(bb) if bb else tmp)
    img = img.resize((max(1, round(img.width / SS)), max(1, round(img.height / SS))), Image.LANCZOS)
    _cache[key] = img
    return img

def scaled(text, path, base_size, color, scale, track=0.0):
    """Rasterise once at base_size, then scale the bitmap.

    Re-rasterising type at a continuously changing point size makes the glyphs
    shimmer, because hinting and rounding land differently every frame. Scaling
    one high-quality raster is smooth."""
    spr = sprite(text, path, base_size, color, track)
    if abs(scale - 1.0) < 0.005:
        return spr
    return spr.resize((max(1, round(spr.width * scale)), max(1, round(spr.height * scale))),
                      Image.LANCZOS)


def blit(canvas, spr, x, y, alpha=1.0, anchor="lt"):
    if alpha <= 0.004: return
    if "c" in anchor: x -= spr.width // 2
    if "r" in anchor: x -= spr.width
    if alpha < 1.0:
        spr = spr.copy()
        spr.putalpha(spr.getchannel("A").point(lambda v: int(v * alpha)))
    canvas.alpha_composite(spr, (int(round(x)), int(round(y))))


# ------------------------------------------------------------------ timeline
T_TITLE = 0.00
T_ORIG = 1.35
T_BLUR = 2.35
T_PIX = 3.60
T_BAR = 4.85
T_SWAP = 6.35
T_CLOSE = 7.85
T_END = 9.40

ROW_Y = [196, 272, 348, 424]
LABEL_X, STRIP_X, VERDICT_X = 56, 236, 660


def render(now):
    base = Image.new("RGBA", (W, H), GRAPHITE + (255,))
    d = ImageDraw.Draw(base)

    prog = clamp(now / T_END)
    d.rectangle([0, H - 4, W, H], fill=(40, 38, 33, 255))
    to = int(W * prog)
    d.rectangle([0, H - 4, to, H], fill=mix(SIGNAL, SAFE, clamp((now - T_BAR) / 2.0)) + (255,))
    d.rectangle([max(0, to - 26), H - 4, to, H], fill=BONE + (200,))

    p = soft_out(seg(now, 0.05, 1.0))
    dy = (1 - p) * 6
    d.rounded_rectangle([60, 50 - dy, 92, 62 - dy], radius=2, fill=(0, 0, 0, int(255 * p)))
    d.rectangle([60, 60 - dy, 92, 62 - dy], fill=SIGNAL + (int(255 * p),))
    blit(base, sprite("BLACKBAR", POP_M, 14, BONE, 2.4), 104, 48 - dy, p)

    # ---- headline: centred while alone, then settles top-left ----
    a_title = window(now, T_TITLE + 0.15, T_END + 1.0, 0.45)
    if a_title > 0:
        e = soft_out(seg(now, T_TITLE + 0.20, 1.1))
        move = smooth(seg(now, T_ORIG - 0.40, 1.0))

        # Always position by the LEFT EDGE and interpolate between the two
        # resting places. Switching anchor mid-move jumped the sprite 166px in
        # one frame — the glitch. Centre is a computed left edge, not a mode.
        spr = scaled("Blur isn\u2019t redaction.", POP_M, 40, BONE, 1 - move * 0.175)
        centred_left = (W - spr.width) / 2
        x = centred_left + (LABEL_X - centred_left) * move
        y = 232 - move * 118 + (1 - e) * 28
        blit(base, spr, x, y, a_title * e)

        # A rule that draws in once the headline has settled — grounds the grid.
        ra = window(now, T_ORIG + 0.10, T_END + 1.0, 0.5) * move
        if ra > 0.01:
            rw = (W - LABEL_X * 2) * soft_out(seg(now, T_ORIG + 0.10, 1.1))
            d.rectangle([LABEL_X, 168, LABEL_X + rw, 169],
                        fill=mix(GRAPHITE, LINE, ra) + (255,))

    swapped = now >= T_SWAP
    text = CARD_B if swapped else CARD_A

    # ---- the four rows ----
    rows = [
        ("ORIGINAL", T_ORIG, "orig"),
        ("BLUR", T_BLUR, "blur"),
        ("PIXELATE", T_PIX, "pix"),
        ("BLACK BAR", T_BAR, "bar"),
    ]
    for i, (label, t0, kind) in enumerate(rows):
        a = window(now, t0, T_END + 1.0, 0.42)
        if a <= 0: continue
        e = soft_out(seg(now, t0, 1.0))
        y = ROW_Y[i] + (1 - e) * 22

        blit(base, sprite(label, MONO, 12, MUTE if kind else DIM, 2.0), LABEL_X, y + 15, a * e)

        # the treated strip — filters ramp on rather than snapping
        if kind == "blur":
            img = blurred(text, 5.0 * smooth(seg(now, t0 + 0.30, 0.85)))
        elif kind == "pix":
            img = pixelated(text, 1 + 8 * smooth(seg(now, t0 + 0.30, 0.85)))
        elif kind == "bar":
            img = strip(text).copy()
            wipe = soft_out(seg(now, t0 + 0.30, 0.55))
            ImageDraw.Draw(img).rectangle([0, 0, SW * wipe, SH], fill=(0, 0, 0))
            if 0 < wipe < 0.97:
                ImageDraw.Draw(img).rectangle([max(0, SW * wipe - 4), 0, SW * wipe, SH], fill=SIGNAL)
        else:
            img = strip(text)

        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        layer.alpha_composite(SHADOW, (STRIP_X - SHADOW_PAD, int(y) - SHADOW_PAD))
        layer.paste(img.convert("RGBA"), (STRIP_X, int(y)))
        ImageDraw.Draw(layer).rectangle([STRIP_X - 1, int(y) - 1, STRIP_X + SW, int(y) + SH],
                                        outline=LINE + (255,), width=1)
        if a * e < 1:
            layer.putalpha(layer.getchannel("A").point(lambda v: int(v * a * e)))
        base.alpha_composite(layer)

        # A tick beside the label, lighting up as the row lands — vertical rhythm.
        tick = smooth(seg(now, t0 + 0.05, 0.6))
        if tick > 0.02:
            tc = SAFE if kind == "bar" else (SIGNAL if kind in ("blur", "pix") else DIM)
            th = 22 * tick
            d.rectangle([LABEL_X - 14, y + 22 - th / 2, LABEL_X - 12, y + 22 + th / 2],
                        fill=mix(GRAPHITE, tc, a * e) + (255,))

        # Verdicts, measured at build time rather than asserted, counting up so
        # the eye lands on the number — which is the whole point of the frame.
        va = window(now, t0 + 0.90, T_END + 1.0, 0.35)
        if va > 0:
            target = {"orig": SHADES_ORIG, "blur": SHADES_BLUR, "pix": SHADES_PIX, "bar": 1}[kind]
            count = max(1, round(target * smooth(seg(now, t0 + 0.90, 0.55))))
            colour = {"orig": MUTE, "blur": SIGNAL, "pix": SIGNAL, "bar": SAFE}[kind]
            label_txt = {"orig": "shades in the original", "blur": "shades survive",
                         "pix": "shades survive", "bar": "shade. Nothing to recover."}[kind]
            pop = 1 + 0.12 * (1 - smooth(seg(now, t0 + 1.42, 0.3))) if kind == "bar" else 1.0
            blit(base, scaled(str(count), POP_M, 30, colour, pop), VERDICT_X, y + 2 - (pop - 1) * 14, va)
            blit(base, sprite(label_txt, POP_L, 15, colour if kind == "bar" else MUTE),
                 VERDICT_X + 54, y + 12, va)

    # ---- the swap: filters change, the bar does not ----
    a_swap = window(now, T_SWAP - 0.15, T_CLOSE + 0.1, 0.35)
    if a_swap > 0:
        e = soft_out(seg(now, T_SWAP - 0.15, 0.9))
        blit(base, sprite("Different number underneath.", POP_L, 17, BONE),
             LABEL_X, 500 + (1 - e) * 14, a_swap * e)
        blit(base, sprite("Two of them changed.", POP_M, 17, SIGNAL),
             LABEL_X + 254, 500 + (1 - e) * 14,
             window(now, T_SWAP + 0.45, T_CLOSE + 0.1, 0.3) * e)

    a_close = window(now, T_CLOSE, T_END + 1.0, 0.40)
    if a_close > 0:
        e = soft_out(seg(now, T_CLOSE, 0.9))
        blit(base, sprite("Two are filters. One is deletion.", POP_M, 19, BONE),
             LABEL_X, 498 + (1 - e) * 14, a_close * e)
        blit(base, sprite("Exports are flattened \u2014 no layer to peel off.", POP_L, 15, DIM),
             LABEL_X, 530 + (1 - e) * 14,
             window(now, T_CLOSE + 0.35, T_END + 1.0, 0.3) * e)

    return base.convert("RGB")


if __name__ == "__main__":
    print(f"measured: blur={SHADES_BLUR} shades, pixelate={SHADES_PIX} shades, bar=1")
    frames = [render(i / FPS) for i in range(int(T_END * FPS))]
    out = "/home/claude/blackbar/store/blackbar-blur-vs-redaction.gif"
    frames[0].save(out, save_all=True, append_images=frames[1:],
                   duration=int(1000 / FPS), loop=0, optimize=True, disposal=2)
    print(f"{out}\n  {len(frames)} frames | {len(frames)/FPS:.1f}s | {W}x{H} | "
          f"{os.path.getsize(out)/1024/1024:.2f} MB")
