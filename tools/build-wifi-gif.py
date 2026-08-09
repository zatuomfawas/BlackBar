#!/usr/bin/env python3
"""
Blackbar — the Wi-Fi test, animated properly.

Rebuilt around three things the first pass lacked:

  1. A TIMELINE. Every element has an entrance time and everything derives from
     a single clock, rather than being assembled scene by scene. That's what
     lets motion overlap across cuts instead of stopping dead at each one.

  2. EASING. Nothing moves linearly. Entrances use expo-out (fast start, long
     settle), which is what reads as responsive software rather than a slide
     transition. Emphasis beats use back-out for a slight overshoot.

  3. SPRITE COMPOSITING. Type is rendered once at 3x into an RGBA sprite, then
     pasted with offset and variable alpha. Cheap enough to run at 20fps, and
     it means every text element gets slide and fade for free.
"""
from PIL import Image, ImageDraw, ImageFont
import math, os, sys

W, H = 1120, 630
FPS = 20
SS = 3

GRAPHITE = (28, 27, 25)
LINE = (58, 54, 46)
BONE = (237, 233, 224)
MUTE = (142, 138, 126)
DIM = (105, 102, 94)
SIGNAL = (242, 193, 78)
SAFE = (143, 185, 150)
RED = (206, 108, 94)
GREY = (78, 74, 66)

GF = "/usr/share/fonts/truetype/google-fonts/"
DJ = "/usr/share/fonts/truetype/dejavu/"
POP_M, POP_L = GF + "Poppins-Medium.ttf", GF + "Poppins-Light.ttf"
MONO = DJ + "DejaVuSansMono.ttf"

# The record is drawn, not cropped from a screenshot: different data from the
# first GIF, and the redaction rectangles come straight out of the layout pass
# instead of being detected back out of a bitmap.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render_card import render as render_card

CARD, BARS, FOUND = render_card(width=512)
CARD_W, CARD_H = CARD.size
CARD_X, CARD_Y = 556, 152
K = 1.0


# ----------------------------------------------------------------- easing
def clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))

def expo_out(t):
    """Kept for emphasis beats only. Front-loads hard: ~90% of the travel
    happens in the first quarter, which is why it must not carry entrances."""
    t = clamp(t)
    return 1.0 if t >= 1 else 1 - pow(2, -10 * t)

def soft_out(t):
    """Quintic ease-out. Still snappy, but the tail stays visible for another
    third of a second — the difference between motion and a still frame."""
    return 1 - pow(1 - clamp(t), 4)

def cubic_out(t):
    return 1 - pow(1 - clamp(t), 3)

def back_out(t, s=1.7):
    t = clamp(t) - 1
    return t * t * ((s + 1) * t + s) + 1

def seg(now, start, dur):
    """Progress through a window: 0 before, 1 after."""
    return 1.0 if dur <= 0 else clamp((now - start) / dur)

def smooth(t):
    """Smoothstep. Symmetric, no front-loading — the right curve for opacity."""
    t = clamp(t)
    return t * t * (3 - 2 * t)

def window(now, start, end, fade=0.40):
    """Alpha for an element alive between start and end."""
    if now < start or now > end:
        return 0.0
    return min(smooth((now - start) / fade), smooth((end - now) / fade))

def mix(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


# ----------------------------------------------------------------- sprites
_cache = {}

def sprite(text, path, size, color, track=0.0):
    """Render text once at 3x, trimmed to its bbox. Reused every frame."""
    key = (text, path, round(size, 2), color, track)
    if key in _cache:
        return _cache[key]
    font = ImageFont.truetype(path, max(4, int(size * SS)))
    pad = int(size * SS)
    tmp = Image.new("RGBA", (int(len(text) * size * SS * 1.5) + pad * 2, int(size * SS * 2.6)), (0, 0, 0, 0))
    d = ImageDraw.Draw(tmp)
    x = pad
    for ch in text:
        d.text((x, pad // 2), ch, font=font, fill=color + (255,))
        x += d.textlength(ch, font=font) + track * SS
    bbox = tmp.getbbox()
    img = tmp.crop(bbox) if bbox else tmp
    img = img.resize((max(1, round(img.width / SS)), max(1, round(img.height / SS))), Image.LANCZOS)
    _cache[key] = img
    return img

def blit(canvas, spr, x, y, alpha=1.0, anchor="lt"):
    if alpha <= 0.004:
        return
    if "c" in anchor:
        x -= spr.width // 2
    if alpha < 1.0:
        spr = spr.copy()
        spr.putalpha(spr.getchannel("A").point(lambda v: int(v * alpha)))
    canvas.alpha_composite(spr, (int(round(x)), int(round(y))))


# ----------------------------------------------------------------- pieces
def wifi(d, dx, dy, scale, arc_alpha, struck, pulse=0.0):
    """(dx, dy) is the DOT — the signal source — and the arcs are concentric
    with it. They used to be centred 8px above the dot, which is why no
    straight line could pass through the middle of the symbol."""
    tone = GREY if struck else SAFE
    for i, r0 in enumerate((36, 24, 13)):
        a = arc_alpha[i]
        if a <= 0.01:
            continue
        r = r0 * scale * (1 + pulse * 0.05 * (3 - i))
        d.arc([dx - r, dy - r, dx + r, dy + r], 213, 327,
              fill=mix(GRAPHITE, tone, a) + (255,), width=max(2, int(4.5 * scale)))
    dr = 4.8 * scale
    d.ellipse([dx - dr, dy - dr, dx + dr, dy + dr],
              fill=mix(GRAPHITE, tone, arc_alpha[2]) + (255,))

def strike(d, dx, dy, scale, p):
    """Corner to corner of the glyph's bounding box, so the slash crosses all
    three arcs and the dot. Drawn on progressively rather than popped in."""
    if p <= 0:
        return
    ex = 0.839 * 36 * scale          # outer arc's horizontal extent
    over = 5 * scale
    x0, y0 = dx - ex - over, dy - 36 * scale - over
    x1, y1 = dx + ex + over, dy + 4.8 * scale + over
    d.line([x0, y0, x0 + (x1 - x0) * p, y0 + (y1 - y0) * p],
           fill=RED + (255,), width=max(3, int(5 * scale)))

def card_with_bars(n_full, partial):
    """Bars already landed, plus one wiping in left to right."""
    c = CARD.copy()
    cd = ImageDraw.Draw(c)
    for i in range(n_full):
        cd.rectangle(list(BARS[i]), fill=(0, 0, 0))
    if partial > 0 and n_full < len(BARS):
        px0, py0, px1, py1 = BARS[n_full]
        edge = px0 + (px1 - px0) * partial
        cd.rectangle([px0, py0, edge, py1], fill=(0, 0, 0))
        # Amber leading edge: reads as the bar being drawn on, not pasted in.
        if partial < 0.97:
            cd.rectangle([max(px0, edge - 3), py0, edge, py1], fill=SIGNAL)
    # The one lower-risk find, left visible for the user to judge.
    if FOUND and n_full >= len(BARS):
        cd.rectangle(list(FOUND), outline=SIGNAL, width=2)
    return c


# ----------------------------------------------------------------- timeline
# Scenes overlap deliberately: the outgoing element is still leaving as the
# next one arrives, so there is no frame where nothing is moving.
T_DOUBT, T_WIFI, T_STRIKE = 0.00, 1.75, 2.75
T_CAPTURE, T_BARS, BAR_GAP = 3.75, 4.70, 0.150
T_VERDICT, T_END = 6.35, 8.70


def render(now):
    base = Image.new("RGBA", (W, H), GRAPHITE + (255,))
    d = ImageDraw.Draw(base)

    # A hairline that fills across the whole loop. Constant, quiet motion —
    # it stops the held beats reading as a frozen slide, and it tells a viewer
    # this is a loop with an end rather than a stalled video.
    prog = clamp(now / T_END)
    d.rectangle([0, H - 4, W, H], fill=(40, 38, 33, 255))
    fill_to = int(W * prog)
    d.rectangle([0, H - 4, fill_to, H],
                fill=mix(SIGNAL, SAFE, clamp((now - T_VERDICT) / 1.4)) + (255,))
    # A brighter head on the fill, so the movement registers at a glance.
    d.rectangle([max(0, fill_to - 26), H - 4, fill_to, H], fill=BONE + (200,))

    # wordmark settles in once and stays
    p = soft_out(seg(now, 0.05, 1.0))
    dy = (1 - p) * 6
    d.rounded_rectangle([60, 52 - dy, 92, 64 - dy], radius=2, fill=(0, 0, 0, int(255 * p)))
    d.rectangle([60, 62 - dy, 92, 64 - dy], fill=SIGNAL + (int(255 * p),))
    blit(base, sprite("BLACKBAR", POP_M, 14, BONE, 2.4), 104, 50 - dy, p)

    # ---- 1. the doubt ----
    a = window(now, T_DOUBT + 0.20, T_WIFI + 0.25, 0.42)
    if a > 0:
        for i, line in enumerate(['\u201cBut how do I know', 'it isn\u2019t uploading?\u201d']):
            e = soft_out(seg(now, T_DOUBT + 0.25 + i * 0.16, 1.15))
            blit(base, sprite(line, POP_M, 44, BONE), W // 2, 258 + i * 58 + (1 - e) * 34, a * e, "ct")

    # ---- 2. wi-fi goes down ----
    a = window(now, T_WIFI, T_CAPTURE + 0.30, 0.45)
    if a > 0:
        grow = back_out(seg(now, T_WIFI + 0.05, 0.55))
        struck = now >= T_STRIKE
        arcs = [
            (1 - cubic_out(seg(now, T_STRIKE + 0.04 + i * 0.09, 0.30)) * 0.72) if struck
            else cubic_out(seg(now, T_WIFI + 0.10 + (2 - i) * 0.09, 0.40))
            for i in range(3)
        ]
        pulse = 0.0 if struck else (math.sin((now - T_WIFI) * 5.6) * 0.5 + 0.5)
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        wifi(ld, W // 2, 274, 1.55 * grow, arcs, struck, pulse * 0.5)
        strike(ld, W // 2, 274, 1.55 * grow, smooth(seg(now, T_STRIKE, 0.42)))
        if a < 1:
            layer.putalpha(layer.getchannel("A").point(lambda v: int(v * a)))
        base.alpha_composite(layer)

        on_a = window(now, T_WIFI + 0.30, T_STRIKE + 0.05, 0.18)
        if on_a > 0:
            blit(base, sprite("Connected", POP_M, 38, MUTE), W // 2, 336, on_a, "ct")
        off_a = window(now, T_STRIKE + 0.10, T_CAPTURE + 0.05, 0.20)
        if off_a > 0:
            e = soft_out(seg(now, T_STRIKE + 0.10, 0.85))
            blit(base, sprite("Wi-Fi off", POP_M, 40, RED), W // 2, 336 + (1 - e) * 14, off_a * e, "ct")
            blit(base, sprite("Airplane mode. No connection at all.", POP_L, 19, DIM), W // 2,
                 394 + (1 - e) * 10, window(now, T_STRIKE + 0.28, T_CAPTURE + 0.05, 0.2) * e, "ct")

    # ---- 3 & 4. capture with no network, then the verdict ----
    stage = window(now, T_CAPTURE, T_END + 1.0, 0.55)
    if stage > 0:
        slide = soft_out(seg(now, T_CAPTURE, 1.30))
        n_full, partial = 0, 0.0
        for i in range(len(BARS)):
            t0 = T_BARS + i * BAR_GAP
            if now >= t0 + 0.32:
                n_full = i + 1
            elif now >= t0:
                partial = soft_out((now - t0) / 0.32)
                break

        cx = CARD_X + int((1 - slide) * 96)
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        layer.paste(card_with_bars(n_full, partial).convert("RGBA"), (cx, CARD_Y))
        ld = ImageDraw.Draw(layer)

        done = smooth(seg(now, T_VERDICT, 0.7))
        glow = 0.82 + 0.18 * (math.sin((now - T_VERDICT) * 2.2) * 0.5 + 0.5) if done > 0.5 else 1.0
        ld.rectangle([cx - 1, CARD_Y - 1, cx + CARD_W, CARD_Y + CARD_H],
                     outline=mix(LINE, SAFE, done * glow) + (255,), width=1 + int(done))

        sp = seg(now, T_CAPTURE + 0.55, 0.85)
        if 0 < sp < 1:
            sy = CARD_Y + int(CARD_H * sp)
            for k in range(52):
                yy = sy - k
                if yy < CARD_Y:
                    break
                ld.rectangle([cx, yy, cx + CARD_W, yy], fill=SIGNAL + (int(56 * (1 - k / 52) ** 1.6),))
            ld.rectangle([cx, sy - 1, cx + CARD_W, sy + 1], fill=SIGNAL + (240,))

        if stage < 1:
            layer.putalpha(layer.getchannel("A").point(lambda v: int(v * stage)))
        base.alpha_composite(layer)

        # offline badge — the proof must never leave frame
        ba = window(now, T_CAPTURE + 0.15, T_END + 1.0, 0.3)
        if ba > 0:
            be = soft_out(seg(now, T_CAPTURE + 0.15, 0.95))
            bx = 62 - (1 - be) * 18
            bl = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            bd = ImageDraw.Draw(bl)
            breathe = 0.30 + 0.16 * (math.sin(now * 2.5) * 0.5 + 0.5)
            wifi(bd, bx + 32, 158, 0.78, [breathe] * 3, True)
            strike(bd, bx + 32, 158, 0.78, 1.0)
            bl.putalpha(bl.getchannel("A").point(lambda v: int(v * ba * be)))
            base.alpha_composite(bl)
            blit(base, sprite("OFFLINE", MONO, 13, RED, 2), bx + 78, 142, ba * be)

        h1 = window(now, T_CAPTURE + 0.30, T_VERDICT + 0.05, 0.24)
        h2 = window(now, T_VERDICT + 0.10, T_END + 1.0, 0.28)
        if h1 > 0:
            e = soft_out(seg(now, T_CAPTURE + 0.30, 1.05))
            blit(base, sprite("Capture anyway.", POP_M, 36, BONE), 60, 212 + (1 - e) * 18, h1 * e)
            for i, line in enumerate(["The page is read on your machine.", "There is nowhere for it to go."]):
                t0 = T_CAPTURE + 0.42 + i * 0.09
                le = soft_out(seg(now, t0, 1.0))
                blit(base, sprite(line, POP_L, 17, MUTE), 60, 268 + i * 26 + (1 - le) * 12,
                     window(now, t0, T_VERDICT + 0.05, 0.22) * le)
        if h2 > 0:
            e = soft_out(seg(now, T_VERDICT + 0.10, 1.05))
            blit(base, sprite("Still works.", POP_M, 38, BONE), 60, 208 + (1 - e) * 18, h2 * e)
            for i, line in enumerate(["No network", "No upload", "No account"]):
                t0 = T_VERDICT + 0.26 + i * 0.13
                le = back_out(seg(now, t0, 0.5))
                la = window(now, t0, T_END + 1.0, 0.22)
                if la <= 0:
                    continue
                y = 268 + i * 32
                r = 4.6 * min(1.0, le)
                d.ellipse([68 - r, y + 10 - r, 68 + r, y + 10 + r], fill=SAFE + (int(255 * la),))
                blit(base, sprite(line, POP_L, 17, BONE), 86 + (1 - le) * 10, y, la * min(1, le))

        ca = window(now, T_BARS, T_END + 1.0, 0.25)
        if ca > 0 and n_full > 0:
            last = T_BARS + (n_full - 1) * BAR_GAP
            pop = 1 + 0.16 * (1 - cubic_out(seg(now, last, 0.26)))
            y = 348 if h1 > h2 else 384
            blit(base, sprite(str(n_full), POP_M, 54 * pop, SIGNAL), 60, y - (pop - 1) * 26, ca)
            blit(base, sprite("SECRETS COVERED", MONO, 11, MUTE, 1.8), 60, y + 74, ca * 0.95)

        fa = window(now, T_CAPTURE + 0.55, T_END + 1.0, 0.35)
        if fa > 0:
            blit(base, sprite("connect-src 'none'", MONO, 15, SIGNAL, 1), 60, 592, fa)
            blit(base, sprite("\u2014 Chrome refuses the connection for us", POP_L, 15, DIM), 264, 590, fa * 0.9)

    return base.convert("RGB")


if __name__ == "__main__":
    frames = [render(i / FPS) for i in range(int(T_END * FPS))]
    out = "/home/claude/blackbar/store/blackbar-wifi-test.gif"
    frames[0].save(out, save_all=True, append_images=frames[1:],
                   duration=int(1000 / FPS), loop=0, optimize=True, disposal=2)
    print(f"{out}\n  {len(frames)} frames | {len(frames)/FPS:.1f}s @ {FPS}fps | "
          f"{W}x{H} | {os.path.getsize(out)/1024/1024:.2f} MB")
