#!/usr/bin/env python3
"""
Blackbar — product showcase.

A faithful rebuild of the editor UI, driven by a cursor through the real
workflow: capture, automatic detection, selective reveal, export.

Motion rules, applied consistently so the whole thing feels like one piece:
  · Position and scale ease with a quintic out — fast departure, long settle.
  · Opacity uses smoothstep. Never an ease-out, which pops.
  · Nothing switches anchor or mode mid-move; positions are always interpolated.
  · Every beat overlaps the next by ~0.3s, so no frame is ever still.
  · The cursor accelerates and decelerates between targets, and dips on click.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render_card import render as render_card

W, H, FPS, SS = 960, 540, 16, 3

GRAPHITE = (28, 27, 25)
MAT = (19, 18, 16)
RAISE = (38, 36, 32)
HOVER = (47, 44, 38)
LINE = (58, 54, 46)
BONE = (237, 233, 224)
MUTE = (142, 138, 126)
DIM = (105, 102, 94)
SIGNAL = (242, 193, 78)
SAFE = (143, 185, 150)

GF = "/usr/share/fonts/truetype/google-fonts/"
DJ = "/usr/share/fonts/truetype/dejavu/"
POP_M, POP_L = GF + "Poppins-Medium.ttf", GF + "Poppins-Light.ttf"
MONO = DJ + "DejaVuSansMono.ttf"

CARD, CARD_BARS, CARD_FOUND = render_card(width=512)

# chrome geometry
TOP_H, RAIL_W, LEDGER_W, STATUS_H = 42, 44, 288, 30
CANVAS_X0, CANVAS_X1 = RAIL_W, W - LEDGER_W
CANVAS_Y0, CANVAS_Y1 = TOP_H, H - STATUS_H

ROWS = [
    ("Email", "critical", 1), ("Phone", "high", 1), ("Street address", "medium", 1),
    ("Postal code", "medium", 1), ("Card number", "critical", 1),
    ("IBAN", "high", 1), ("API key", "critical", 1), ("IP address", "medium", 1),
]
REVEAL_ROW = 4  # "Card number" — the one the cursor toggles


# ---------------------------------------------------------------- easing
def clamp(v, lo=0.0, hi=1.0): return max(lo, min(hi, v))
def smooth(t): t = clamp(t); return t * t * (3 - 2 * t)
def soft_out(t): return 1 - pow(1 - clamp(t), 4)
def back_out(t, s=1.6): t = clamp(t) - 1; return t * t * ((s + 1) * t + s) + 1
def seg(now, s, d): return 1.0 if d <= 0 else clamp((now - s) / d)
def window(now, s, e, fade=0.35):
    if now < s or now > e: return 0.0
    return min(smooth((now - s) / fade), smooth((e - now) / fade))
def mix(a, b, t):
    t = clamp(t)
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
def lerp(a, b, t): return a + (b - a) * clamp(t)


# ---------------------------------------------------------------- sprites
_cache = {}

def line_h(path, size):
    """Full line box for a font at a size: ascender + descender."""
    f = ImageFont.truetype(path, max(4, int(size * SS)))
    a, dsc = f.getmetrics()
    return (a + dsc) / SS


def sprite(text, path, size, color, track=0.0):
    """Trimmed HORIZONTALLY only; the vertical box is always the font's full
    line height, with the ascender line at y=0.

    Trimming vertically as well is the obvious thing to do and it is wrong:
    "Email" has no descender and "API key" does, so their ink boxes have
    different heights. Positioning both by the top of their ink puts their
    baselines on different lines. Keeping a constant vertical box means any two
    strings of the same font and size share a baseline automatically."""
    key = (text, path, round(size, 2), color, track)
    if key in _cache: return _cache[key]

    font = ImageFont.truetype(path, max(4, int(size * SS)))
    asc, dsc = font.getmetrics()
    lh = asc + dsc
    pad = int(size * SS)
    tmp = Image.new("RGBA", (int(len(text) * size * SS * 1.8) + pad * 2, lh), (0, 0, 0, 0))
    d = ImageDraw.Draw(tmp)
    x = pad
    for ch in text:
        d.text((x, 0), ch, font=font, fill=color + (255,))
        x += d.textlength(ch, font=font) + track * SS
    bb = tmp.getbbox()
    img = tmp.crop((bb[0], 0, bb[2], lh)) if bb else tmp
    img = img.resize((max(1, round(img.width / SS)), max(1, round(img.height / SS))), Image.LANCZOS)
    _cache[key] = img
    return img


def blit_mid(c, spr, x, box_top, box_h, alpha=1.0, anchor="lt"):
    """Vertically centre a sprite inside a box of known height."""
    blit(c, spr, x, box_top + (box_h - spr.height) / 2, alpha, anchor)

def blit(c, spr, x, y, alpha=1.0, anchor="lt"):
    if alpha <= 0.004: return
    if "c" in anchor: x -= spr.width / 2
    if "r" in anchor: x -= spr.width
    if alpha < 1.0:
        spr = spr.copy()
        spr.putalpha(spr.getchannel("A").point(lambda v: int(v * alpha)))
    c.alpha_composite(spr, (int(round(x)), int(round(y))))


def _shadow(w, h, blur=5, alpha=150):
    pad = blur * 3
    s = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    ImageDraw.Draw(s).rectangle([pad, pad + 3, pad + w, pad + h + 3], fill=(0, 0, 0, alpha))
    return s.filter(ImageFilter.GaussianBlur(blur)), pad


# ---------------------------------------------------------------- timeline
# The intro is the product in one gesture: a line of sensitive text, a bar that
# covers it, and that same bar settling into place as the logo mark.
T_TEXT   = 0.15   # the sensitive line fades up
T_WIPE   = 0.72   # the bar sweeps across and covers it
T_MORPH  = 1.32   # the bar contracts into the mark
T_WORD   = 1.62   # BLACKBAR letters stagger in beside it
T_TAG    = 2.10   # tagline
INTRO    = 3.05   # hand-off to the showcase

T_PAGE   = INTRO + 0.00   # the page, before anything
T_KEY    = INTRO + 0.70
T_SNAP   = INTRO + 1.25   # capture flash, chrome assembles
T_LEDGER = INTRO + 2.10
T_BARS   = INTRO + 2.95
T_HOVER  = INTRO + 4.60
T_REVEAL = INTRO + 5.25
T_RECOVER= INTRO + 6.35
T_SAVE   = INTRO + 7.35
T_TOAST  = INTRO + 8.20
T_PROOF  = INTRO + 9.30
T_END    = INTRO + 11.10

ROW_Y0, ROW_STEP, ROW_H = TOP_H + 56, 33, 26
PAD = 20                      # one gutter, used on both sides of the ledger
REVEAL_Y = ROW_Y0 + 4 * ROW_STEP + 11      # centre of the "Card number" row

CURSOR_PATH = [
    (T_SNAP,    (820, 430)),
    (T_HOVER,   (742, REVEAL_Y)),
    (T_REVEAL,  (742, REVEAL_Y)),
    (T_RECOVER, (742, REVEAL_Y)),
    (T_SAVE,    (W - 62, 22)),
    (T_TOAST,   (W - 62, 22)),
    (T_PROOF,   (140, H - 16)),
    (T_END,     (140, H - 16)),
]


def cursor_pos(now):
    if now <= CURSOR_PATH[0][0]: return CURSOR_PATH[0][1]
    for i in range(len(CURSOR_PATH) - 1):
        t0, p0 = CURSOR_PATH[i]
        t1, p1 = CURSOR_PATH[i + 1]
        if t0 <= now <= t1:
            e = smooth(seg(now, t0, (t1 - t0) * 0.75))
            return (lerp(p0[0], p1[0], e), lerp(p0[1], p1[1], e))
    return CURSOR_PATH[-1][1]


def click_dip(now):
    """A short scale dip on each click, so presses read as presses."""
    for t in (T_REVEAL, T_RECOVER, T_SAVE + 0.55):
        if 0 <= now - t < 0.28:
            return 1 - 0.22 * math.sin((now - t) / 0.28 * math.pi)
    return 1.0


def draw_cursor(base, x, y, scale, alpha):
    if alpha <= 0.01: return
    l = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(l)
    s = 15 * scale
    pts = [(x, y), (x, y + s * 1.32), (x + s * 0.35, y + s * 0.98),
           (x + s * 0.58, y + s * 1.46), (x + s * 0.80, y + s * 1.36),
           (x + s * 0.57, y + s * 0.89), (x + s * 0.95, y + s * 0.86)]
    d.polygon(pts, fill=(250, 248, 244, 255), outline=(20, 19, 17, 255))
    if alpha < 1:
        l.putalpha(l.getchannel("A").point(lambda v: int(v * alpha)))
    base.alpha_composite(l)


# ---------------------------------------------------------------- intro
INTRO_SECRET = "d.okonkwo@meridianhealth.org"


def draw_intro(base, d, now, alpha):
    """A line of sensitive text, a bar that covers it, and that bar contracting
    into the logo mark. The mark is a redaction, so the intro should be one."""
    if alpha <= 0.01:
        return

    txt = sprite(INTRO_SECRET, MONO, 21, (236, 232, 223))
    tx, ty = (W - txt.width) / 2, 246

    # the text is only visible until the bar has passed over it
    ta = window(now, T_TEXT, T_WIPE + 0.55, 0.30) * (1 - smooth(seg(now, T_MORPH - 0.10, 0.30)))
    te = soft_out(seg(now, T_TEXT, 0.75))
    blit(base, txt, tx, ty + (1 - te) * 10, ta * te * alpha)

    # bar geometry: covering the line -> contracted into the mark
    pad = 13
    x0a, y0a = tx - pad, ty - 7
    x1a, y1a = tx + txt.width + pad, ty + txt.height + 7

    LETTER_GAP = 5.0
    glyphs = [sprite(ch, POP_M, 27, BONE) for ch in "BLACKBAR"]
    word_w = sum(g.width for g in glyphs) + LETTER_GAP * (len(glyphs) - 1)
    mark_w, mark_h, gap = 50, 19, 20
    group = mark_w + gap + word_w
    mx = (W - group) / 2
    my = 250
    x0b, y0b, x1b, y1b = mx, my, mx + mark_w, my + mark_h

    m = smooth(seg(now, T_MORPH, 0.72))
    wipe = soft_out(seg(now, T_WIPE, 0.60))

    bx0 = lerp(x0a, x0b, m)
    by0 = lerp(y0a, y0b, m)
    by1 = lerp(y1a, y1b, m)
    full_x1 = lerp(x1a, x1b, m)
    bx1 = bx0 + (full_x1 - bx0) * (wipe if m < 0.01 else 1.0)

    if bx1 > bx0 + 1:
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        r = 2 if m > 0.5 else 1
        ld.rounded_rectangle([bx0, by0, bx1, by1], radius=r, fill=(0, 0, 0, 255))
        # amber leading edge while it is still sweeping
        if 0.02 < wipe < 0.97 and m < 0.01:
            ld.rectangle([max(bx0, bx1 - 5), by0, bx1, by1], fill=SIGNAL + (255,))
        # the underline resolves as it becomes the mark
        ua = smooth(seg(now, T_MORPH + 0.22, 0.5))
        if ua > 0.01:
            ld.rectangle([bx0, by1 - 3, bx1, by1], fill=SIGNAL + (int(255 * ua),))
        layer.putalpha(layer.getchannel("A").point(lambda v: int(v * alpha)))
        base.alpha_composite(layer)

    # wordmark, letter by letter
    wa = window(now, T_WORD, INTRO + 0.6, 0.32)
    if wa > 0:
        x = mx + mark_w + gap
        for i, g in enumerate(glyphs):
            ce = soft_out(seg(now, T_WORD + i * 0.045, 0.55))
            # Optically centre the cap-height wordmark against the mark.
            blit(base, g, x, my + mark_h / 2 - g.height / 2 - 1 + (1 - ce) * 7, wa * ce * alpha)
            x += g.width + LETTER_GAP

    # tagline
    ga = window(now, T_TAG, INTRO + 0.5, 0.30)
    if ga > 0:
        ge = soft_out(seg(now, T_TAG, 0.7))
        tag = sprite("Screenshots with the secrets already covered.", POP_L, 16, MUTE)
        blit(base, tag, mx + group / 2 - tag.width / 2, 300 + (1 - ge) * 10, ga * ge * alpha)


# ---------------------------------------------------------------- render
def render(now):
    base = Image.new("RGBA", (W, H), MAT + (255,))
    d = ImageDraw.Draw(base)

    assemble = smooth(seg(now, T_SNAP, 0.85))
    revealed = (now >= T_REVEAL) and (now < T_RECOVER)

    # Intro and showcase cross-fade rather than cut: the logo is still leaving
    # as the page arrives, so the intro has to be composited LAST.
    show = smooth(seg(now, INTRO - 0.55, 0.55))
    intro_a = 1.0 - smooth(seg(now, INTRO - 0.60, 0.50))

    def loop_bar():
        prog = clamp(now / T_END)
        d.rectangle([0, H - 3, W, H], fill=(42, 40, 35, 255))
        to = int(W * prog)
        d.rectangle([0, H - 3, to, H], fill=mix(SIGNAL, SAFE, clamp((now - T_SAVE) / 2.2)) + (255,))
        d.rectangle([max(0, to - 22), H - 3, to, H], fill=BONE + (190,))

    if show <= 0.01:
        draw_intro(base, d, now, intro_a)
        loop_bar()
        return base.convert("RGB")

    # ---- canvas mat ----
    d.rectangle([CANVAS_X0, CANVAS_Y0, CANVAS_X1, CANVAS_Y1], fill=MAT + (255,))

    # ---- the card: a full page that shrinks into the editor canvas ----
    grow = soft_out(seg(now, T_SNAP, 1.15))
    # A whisper of drift before the capture — a held opening frame reads as a
    # broken image rather than a deliberate beat.
    idle = 0.0 if now >= T_SNAP else math.sin(now * 1.6) * 2.2
    cw = lerp(516, 430, grow)
    ch = round(cw * CARD.height / CARD.width)
    cx = lerp((W - 516) / 2, (CANVAS_X0 + CANVAS_X1) / 2 - 215, grow)
    cy = lerp(34, CANVAS_Y0 + 62, grow) + idle * (1 - grow)
    k = cw / CARD.width

    n_bars, partial = 0, 0.0
    for i in range(len(CARD_BARS)):
        t0 = T_BARS + i * 0.135
        if now >= t0 + 0.30: n_bars = i + 1
        elif now >= t0:
            partial = soft_out((now - t0) / 0.30); break

    card = CARD.copy()
    cd = ImageDraw.Draw(card)
    for i in range(n_bars):
        if i == REVEAL_ROW and revealed: continue
        cd.rectangle(list(CARD_BARS[i]), fill=(0, 0, 0))
    if partial > 0 and n_bars < len(CARD_BARS):
        x0, y0, x1, y1 = CARD_BARS[n_bars]
        edge = x0 + (x1 - x0) * partial
        cd.rectangle([x0, y0, edge, y1], fill=(0, 0, 0))
        if partial < 0.96:
            cd.rectangle([max(x0, edge - 4), y0, edge, y1], fill=SIGNAL)
    # the revealed row gets an amber outline while it is uncovered
    if revealed and n_bars > REVEAL_ROW:
        cd.rectangle(list(CARD_BARS[REVEAL_ROW]), outline=SIGNAL, width=3)
    if CARD_FOUND and n_bars >= len(CARD_BARS):
        cd.rectangle(list(CARD_FOUND), outline=SIGNAL, width=2)

    card = card.resize((int(cw), ch), Image.LANCZOS)
    cl = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sh, pad = _shadow(int(cw), ch, blur=6, alpha=140)
    cl.alpha_composite(sh, (int(cx) - pad, int(cy) - pad))
    cl.paste(card.convert("RGBA"), (int(cx), int(cy)))
    ImageDraw.Draw(cl).rectangle([cx - 1, cy - 1, cx + cw, cy + ch], outline=LINE + (255,), width=1)
    if show < 1:
        cl.putalpha(cl.getchannel("A").point(lambda v: int(v * show)))
    base.alpha_composite(cl)

    # ---- shortcut hint, before the capture ----
    a_key = window(now, T_KEY, T_SNAP + 0.15, 0.28)
    if a_key > 0:
        e = soft_out(seg(now, T_KEY, 0.5))
        kx, ky = W / 2, 474 + (1 - e) * 14
        for i, key in enumerate(["Alt", "Shift", "S"]):
            spr = sprite(key, MONO, 14, BONE)
            bw = spr.width + 22
            bx = kx - (3 * 78) / 2 + i * 78
            d.rounded_rectangle([bx, ky, bx + bw, ky + 27], radius=5,
                                fill=RAISE + (int(255 * a_key),), outline=LINE + (int(255 * a_key),))
            blit_mid(base, spr, bx + bw / 2, ky, 27, a_key, "ct")
        blit(base, sprite("Press to capture", POP_L, 12.5, DIM), kx, ky + 36, a_key * 0.9, "ct")

    # ---- capture flash ----
    flash = window(now, T_SNAP - 0.05, T_SNAP + 0.40, 0.16)
    if flash > 0:
        fl = Image.new("RGBA", (W, H), BONE + (int(150 * flash),))
        base.alpha_composite(fl)

    # ---- chrome: top bar, rail, ledger, status ----
    if assemble > 0.01:
        a = assemble
        # top bar slides down
        ty = lerp(-TOP_H, 0, soft_out(seg(now, T_SNAP, 0.75)))
        d.rectangle([0, ty, W, ty + TOP_H], fill=GRAPHITE + (255,))
        d.line([0, ty + TOP_H, W, ty + TOP_H], fill=LINE + (255,))
        d.rounded_rectangle([18, ty + 17, 44, ty + 27], radius=2, fill=(0, 0, 0, 255))
        d.rectangle([18, ty + 25, 44, ty + 27], fill=SIGNAL + (255,))
        blit_mid(base, sprite("BLACKBAR", POP_M, 11.5, BONE, 2.2), 54, ty, TOP_H, a)
        blit_mid(base, sprite("app.internal/accounts/48213", MONO, 10.5, DIM), 158, ty, TOP_H, a * 0.9)

        for i, (label, prim) in enumerate([("Copy image", False), ("Save PNG", True)]):
            bw = 84 if prim else 88
            bx = W - 18 - bw - (0 if prim else bw + 8)
            hot = prim and window(now, T_SAVE + 0.25, T_TOAST + 0.3, 0.2) > 0.4
            fill = BONE if prim else RAISE
            if hot: fill = (255, 255, 255)
            d.rounded_rectangle([bx, ty + 10, bx + bw, ty + 34], radius=6,
                                fill=fill + (255,), outline=(BONE if prim else LINE) + (255,))
            blit_mid(base, sprite(label, POP_M if prim else POP_L, 12, (32, 30, 26) if prim else BONE),
                     bx + bw / 2, ty + 10, 24, a, "ct")

        # tool rail slides in from the left
        rx = lerp(-RAIL_W, 0, soft_out(seg(now, T_SNAP + 0.06, 0.75)))
        d.rectangle([rx, TOP_H, rx + RAIL_W, H - STATUS_H], fill=GRAPHITE + (255,))
        d.line([rx + RAIL_W, TOP_H, rx + RAIL_W, H - STATUS_H], fill=LINE + (255,))
        for i in range(8):
            iy = TOP_H + 16 + i * 36
            sel = i == 0
            if sel:
                d.rounded_rectangle([rx + 6, iy - 4, rx + 40, iy + 26], radius=7,
                                    fill=RAISE + (255,), outline=LINE + (255,))
            c = BONE if sel else MUTE
            if i == 0:
                d.rounded_rectangle([rx + 12, iy + 7, rx + 34, iy + 15], radius=2, fill=(0, 0, 0, 255))
                d.rectangle([rx + 12, iy + 14, rx + 34, iy + 15], fill=SIGNAL + (255,))
            elif i == 1:
                for bxq in range(3):
                    for byq in range(2):
                        if (bxq + byq) % 2 == 0:
                            d.rectangle([rx + 13 + bxq * 7, iy + 6 + byq * 7,
                                         rx + 18 + bxq * 7, iy + 11 + byq * 7], fill=c + (255,))
            elif i == 2:
                d.ellipse([rx + 14, iy + 4, rx + 32, iy + 22], outline=c + (255,), width=2)
            elif i == 3:
                d.rectangle([rx + 14, iy + 6, rx + 32, iy + 20], outline=c + (255,), width=2)
            elif i == 4:
                d.line([rx + 14, iy + 20, rx + 31, iy + 5], fill=c + (255,), width=2)
                d.line([rx + 31, iy + 5, rx + 31, iy + 12], fill=c + (255,), width=2)
                d.line([rx + 31, iy + 5, rx + 24, iy + 5], fill=c + (255,), width=2)
            elif i == 5:
                d.rectangle([rx + 14, iy + 16, rx + 32, iy + 21], fill=mix(GRAPHITE, c, 0.5) + (255,))
                d.rectangle([rx + 18, iy + 4, rx + 28, iy + 16], fill=c + (255,))
            elif i == 6:
                d.line([rx + 15, iy + 6, rx + 31, iy + 6], fill=c + (255,), width=2)
                d.line([rx + 23, iy + 6, rx + 23, iy + 21], fill=c + (255,), width=2)
            else:
                d.line([rx + 17, iy + 3, rx + 17, iy + 19], fill=c + (255,), width=2)
                d.line([rx + 13, iy + 8, rx + 33, iy + 8], fill=c + (255,), width=2)

        # ledger slides in from the right
        lx = lerp(W, W - LEDGER_W, soft_out(seg(now, T_SNAP + 0.12, 0.8)))
        d.rectangle([lx, TOP_H, W, H - STATUS_H], fill=GRAPHITE + (255,))
        d.line([lx, TOP_H, lx, H - STATUS_H], fill=LINE + (255,))
        blit_mid(base, sprite("FOUND", MONO, 10, MUTE, 2.0), lx + PAD + 18, TOP_H + 10, 26, a)

        shown = sum(1 for i in range(len(ROWS)) if now >= T_LEDGER + i * 0.11)
        blit_mid(base, sprite(str(shown), POP_M, 22, BONE), W - PAD, TOP_H + 8, 30, a, "rt")
        d.line([lx + PAD, TOP_H + 44, W - PAD, TOP_H + 44], fill=LINE + (255,))

        # ledger rows
        cur_x, cur_y = cursor_pos(now)
        for i, (label, sev, cnt) in enumerate(ROWS):
            t0 = T_LEDGER + i * 0.11
            ra = window(now, t0, T_END + 1.0, 0.32)
            if ra <= 0: continue
            re_ = soft_out(seg(now, t0, 0.7))
            ry = ROW_Y0 + i * ROW_STEP + (1 - re_) * 12

            hovered = (i == REVEAL_ROW and T_HOVER - 0.25 <= now < T_SAVE - 0.35
                       and abs(cur_y - (ry + 12)) < 26)
            if hovered:
                d.rounded_rectangle([lx + PAD - 8, ry - 3, W - PAD + 8, ry + ROW_H + 3], radius=6,
                                    fill=HOVER + (int(255 * ra),))

            # Dot hangs in the margin; the label column is the text grid.
            dot = SIGNAL if sev == "critical" else (mix(GRAPHITE, SIGNAL, 0.68) if sev == "high" else MUTE)
            dcy = ry + ROW_H / 2
            d.ellipse([lx + PAD, dcy - 3.5, lx + PAD + 7, dcy + 3.5],
                      fill=mix(GRAPHITE, dot, ra) + (255,))
            blit_mid(base, sprite(label, POP_L, 13, BONE), lx + PAD + 18, ry, ROW_H, ra * re_)

            on = not (i == REVEAL_ROW and revealed)
            bs = sprite("HIDDEN" if on else "VISIBLE", MONO, 8.5, MUTE if on else SIGNAL, 1.4)
            bw, bh = bs.width + 16, 16
            bx0, by0 = W - PAD - bw, ry + (ROW_H - bh) / 2
            d.rounded_rectangle([bx0, by0, bx0 + bw, by0 + bh], radius=3,
                                fill=((0, 0, 0) if on else mix(GRAPHITE, SIGNAL, 0.18)) + (int(255 * ra),))
            blit_mid(base, bs, bx0 + 8, by0, bh, ra)

        # status bar
        sy = lerp(H, H - STATUS_H, soft_out(seg(now, T_SNAP + 0.10, 0.8)))
        d.rectangle([0, sy, W, H], fill=GRAPHITE + (255,))
        d.line([0, sy, W, sy], fill=LINE + (255,))
        pr = window(now, T_PROOF, T_END + 1.0, 0.4)
        base_pulse = 0.18 * (math.sin(now * 2.1) * 0.5 + 0.5)
        pulse = base_pulse + (0.55 + 0.45 * (math.sin((now - T_PROOF) * 3.4) * 0.5 + 0.5) - base_pulse) * pr
        scy = sy + STATUS_H / 2
        d.ellipse([PAD, scy - 3, PAD + 6, scy + 3], fill=mix(GRAPHITE, SAFE, 0.5 + 0.5 * pulse) + (255,))
        blit_mid(base, sprite("OFFLINE \u00b7 VERIFIED", MONO, 10, mix(MUTE, SAFE, pulse), 1.6),
                 PAD + 14, sy, STATUS_H, a)
        blit_mid(base, sprite("512 \u00d7 373", MONO, 10, DIM, 1.2), 190, sy, STATUS_H, a * 0.8)
        good = window(now, T_BARS + 1.4, T_END + 1.0, 0.4)
        if revealed:
            blit_mid(base, sprite("1 exposed", MONO, 10, SIGNAL, 1.2), 268, sy, STATUS_H, 1.0)
        elif good > 0:
            blit_mid(base, sprite("clear", MONO, 10, SAFE, 1.2), 268, sy, STATUS_H, good)
        blit_mid(base, sprite("\u2318Z undo  \u00b7  \u2318\u23ce save", MONO, 10, DIM, 1.2),
                 W - PAD, sy, STATUS_H, a * 0.8, "rt")

    # ---- toast ----
    a_toast = window(now, T_TOAST, T_PROOF + 0.5, 0.3)
    if a_toast > 0:
        e = back_out(seg(now, T_TOAST, 0.55))
        msg = "Saved. Redactions burned into the pixels."
        spr = sprite(msg, POP_L, 13.5, BONE)
        # Symmetric padding: gutter | dot | gap | text | gutter. Sizing the
        # plate to text+34 while starting the text at +32 left a 2px right
        # margin against a 32px left one.
        GUT, DOT, GAP = 15, 8, 11
        bw, bh = GUT + DOT + GAP + spr.width + GUT, 38
        bx, by = (CANVAS_X0 + CANVAS_X1 - bw) / 2, H - STATUS_H - 96 + (1 - e) * 16
        sh2, p2 = _shadow(int(bw), bh, blur=6, alpha=120)
        tl = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        tl.alpha_composite(sh2, (int(bx) - p2, int(by) - p2))
        td = ImageDraw.Draw(tl)
        td.rounded_rectangle([bx, by, bx + bw, by + bh], radius=8,
                             fill=RAISE + (255,), outline=LINE + (255,))
        dcy = by + bh / 2
        td.ellipse([bx + GUT, dcy - DOT / 2, bx + GUT + DOT, dcy + DOT / 2], fill=SAFE + (255,))
        tl.putalpha(tl.getchannel("A").point(lambda v: int(v * a_toast)))
        base.alpha_composite(tl)
        blit_mid(base, spr, bx + GUT + DOT + GAP, by, bh, a_toast)

    # ---- caption band ----
    caps = [
        (T_PAGE + 0.35, T_SNAP + 0.2, "A page full of things you shouldn\u2019t share."),
        (T_BARS + 0.5, T_HOVER + 0.2, "Detected and covered before you saw it."),
        (T_REVEAL - 0.1, T_SAVE - 0.1, "Uncover only what you want seen."),
        (T_SAVE - 0.35, T_TOAST - 0.15, "Export flattens it \u2014 no layer to peel off."),
        (T_PROOF + 0.2, T_END + 1.0, "None of it ever left this machine."),
    ]
    for s, e, text in caps:
        ca = window(now, s, e, 0.32)
        if ca <= 0: continue
        ce = soft_out(seg(now, s, 0.7))
        spr = sprite(text, POP_M, 17, BONE)
        # Once the chrome is up the caption belongs to the canvas column, whose
        # centre is well left of the frame centre.
        mid = (CANVAS_X0 + CANVAS_X1) / 2 if assemble > 0.5 else W / 2
        y = (H - STATUS_H - 40) if assemble > 0.5 else 448
        blit(base, spr, mid - spr.width / 2, y + (1 - ce) * 12, ca * ce)

    # ---- the intro, still fading out over the incoming page ----
    if intro_a > 0.01:
        draw_intro(base, d, now, intro_a)

    # ---- loop progress: constant quiet motion, and it ties the three clips
    #      in this set together visually ----
    loop_bar()

    # ---- cursor, above everything ----
    ca = window(now, T_SNAP + 0.35, T_END + 1.0, 0.35)
    cx_, cy_ = cursor_pos(now)
    draw_cursor(base, cx_, cy_, click_dip(now), ca)

    return base.convert("RGB")


if __name__ == "__main__":
    frames = [render(i / FPS) for i in range(int(T_END * FPS))]

    # One palette for the whole clip. Quantising each frame independently lets
    # the palette drift between frames, which shimmers on flat colour — and it
    # compresses worse, because no two frames share a colour table.
    sample = Image.new("RGB", (W, H * 3))
    for i, at in enumerate((1.0, 8.4, 12.4)):
        sample.paste(frames[min(len(frames) - 1, int(at * FPS))], (0, H * i))
    palette = sample.quantize(colors=72, method=Image.MEDIANCUT, dither=Image.NONE)
    q = [f.quantize(palette=palette, dither=Image.NONE) for f in frames]

    out = "/home/claude/blackbar/store/blackbar-showcase.gif"
    q[0].save(out, save_all=True, append_images=q[1:],
              duration=int(1000 / FPS), loop=0, optimize=True, disposal=2)
    print(f"{out}\n  {len(frames)} frames | {len(frames)/FPS:.1f}s @ {FPS}fps | {W}x{H} | "
          f"72-colour global palette | {os.path.getsize(out)/1024/1024:.2f} MB")
