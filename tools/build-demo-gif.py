#!/usr/bin/env python3
"""
Build the demo GIF for X.

Every pixel of the card is a real capture — the "before" is the untouched demo
page, and the bar positions were measured off the real editor output, so the
animation reproduces what actually happened rather than illustrating it.

Sized and paced for autoplay in a timeline: short loop, big type, the payoff
inside the first two seconds.
"""
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 675
SS = 3                      # text supersampling
GRAPHITE = (28, 27, 25)
MAT = (19, 18, 16)
LINE = (58, 54, 46)
BONE = (237, 233, 224)
MUTE = (142, 138, 126)
DIM = (109, 106, 97)
SIGNAL = (242, 193, 78)
SAFE = (143, 185, 150)

GF = "/usr/share/fonts/truetype/google-fonts/"
DJ = "/usr/share/fonts/truetype/dejavu/"
POP_M, POP_L = GF + "Poppins-Medium.ttf", GF + "Poppins-Light.ttf"
MONO = DJ + "DejaVuSansMono.ttf"

# Bars, measured from the real editor output (573x402 card space).
BARS_573 = [
    (144,  96, 365, 115),
    (144, 134, 251, 152),
    (144, 171, 242, 189),
    (144, 208, 195, 227),
    (144, 247, 281, 263),
    (144, 285, 281, 301),
    (144, 322, 338, 338),
]

CARD_W, CARD_H = 620, 435
CARD_X, CARD_Y = 530, 122
SCALE = CARD_W / 573.0

base_card = Image.open('/tmp/card_before.png').convert("RGB").resize((CARD_W, CARD_H), Image.LANCZOS)


def bar_rect(i):
    x0, y0, x1, y1 = BARS_573[i]
    return (round(x0 * SCALE), round(y0 * SCALE), round(x1 * SCALE), round(y1 * SCALE))


class Type:
    """Text drawn at 3x on an overlay, downsampled — keeps type crisp."""
    def __init__(self):
        self.ov = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.ov)

    def f(self, path, size):
        return ImageFont.truetype(path, int(size * SS))

    def at(self, xy, text, font, fill, alpha=255):
        self.d.text((xy[0] * SS, xy[1] * SS), text, font=font, fill=fill + (alpha,))

    def tracked(self, xy, text, font, fill, track=0, alpha=255):
        x, y = xy[0] * SS, xy[1] * SS
        for ch in text:
            self.d.text((x, y), ch, font=font, fill=fill + (alpha,))
            x += self.d.textlength(ch, font=font) + track * SS

    def width(self, text, font, track=0):
        return (sum(self.d.textlength(c, font=font) for c in text) + track * SS * (len(text) - 1)) / SS

    def onto(self, canvas):
        return Image.alpha_composite(
            canvas.convert("RGBA"), self.ov.resize((W, H), Image.LANCZOS)
        ).convert("RGB")


def frame(bars_shown, headline, sub=None, count=None, scan_y=None,
          scan_alpha=255, outro=False, ring=False):
    canvas = Image.new("RGB", (W, H), GRAPHITE)
    d = ImageDraw.Draw(canvas)

    if not outro:
        card = base_card.copy()
        cd = ImageDraw.Draw(card)
        for i in range(bars_shown):
            x0, y0, x1, y1 = bar_rect(i)
            cd.rectangle([x0, y0, x1, y1], fill=(0, 0, 0))
        canvas.paste(card, (CARD_X, CARD_Y))

        # Amber sweep while the page is being read. Composited with alpha so it
        # tints whatever is underneath — blending toward a fixed colour painted
        # dark bands across the white card.
        if scan_y is not None:
            sy = CARD_Y + scan_y
            glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            gd = ImageDraw.Draw(glow)
            trail = 46
            for k in range(trail):
                yy = sy - k
                if yy < CARD_Y:
                    break
                gd.rectangle([CARD_X, yy, CARD_X + CARD_W, yy],
                             fill=SIGNAL + (int(52 * (1 - k / trail) ** 1.6),))
            gd.rectangle([CARD_X, sy - 1, CARD_X + CARD_W, sy + 1], fill=SIGNAL + (235,))
            canvas = Image.alpha_composite(canvas.convert("RGBA"), glow).convert("RGB")
            d = ImageDraw.Draw(canvas)

        d.rectangle([CARD_X - 1, CARD_Y - 1, CARD_X + CARD_W, CARD_Y + CARD_H],
                    outline=SAFE if ring else LINE, width=2 if ring else 1)

    t = Type()

    # Wordmark, always present.
    d.rounded_rectangle([60, 58, 92, 70], radius=2, fill=(0, 0, 0))
    d.rectangle([60, 68, 92, 70], fill=SIGNAL)
    t.tracked((104, 55), "BLACKBAR", t.f(POP_M, 15), BONE, 2.4)

    if outro:
        f_big = t.f(POP_M, 46)
        w = t.width(headline, f_big)
        t.at(((W - w) / 2, 268), headline, f_big, BONE)
        if sub:
            f_s = t.f(POP_L, 21)
            ws = t.width(sub, f_s)
            t.at(((W - ws) / 2, 336), sub, f_s, MUTE)
        f_c = t.f(MONO, 13)
        cta = "CHROME WEB STORE  \u00b7  FREE"
        wc = t.width(cta, f_c, 2)
        t.tracked(((W - wc) / 2, 420), cta, f_c, SIGNAL, 2)
        return t.onto(canvas)

    # Left column. Everything below the headline is positioned from it, so a
    # two-line and a three-line headline both lay out correctly.
    f_h = t.f(POP_M, 36)
    lines = headline.split("\n")
    head_y, lead = 158, 47
    for i, line in enumerate(lines):
        t.at((60, head_y + i * lead), line, f_h, BONE)

    y = head_y + len(lines) * lead + 18
    if sub:
        f_s = t.f(POP_L, 17)
        for i, line in enumerate(sub.split("\n")):
            t.at((60, y + i * 26), line, f_s, MUTE)
        y += len(sub.split("\n")) * 26 + 26

    if count is not None:
        t.at((60, y), str(count), t.f(POP_M, 58), SIGNAL)
        t.tracked((60, y + 76), "SECRETS COVERED", t.f(MONO, 11), MUTE, 1.8)

    f_f = t.f(MONO, 12)
    foot = "NOTHING LEAVES YOUR DEVICE"
    t.tracked((60, 588), foot, f_f, DIM, 1.8)

    return t.onto(canvas)


frames, durations = [], []


def hold(img, ms, n=1):
    for _ in range(n):
        frames.append(img)
        durations.append(ms)


# --- 1. the problem -----------------------------------------------------
before = frame(0, "Every screenshot\nyou send looks\nlike this.",
               sub="Card numbers. An IBAN. An API key.\nAll of it readable.")
hold(before, 90, 16)

# --- 2. reading ---------------------------------------------------------
for i in range(11):
    y = int(CARD_H * i / 10)
    frames.append(frame(0, "It reads the page\nbefore it captures it.",
                        sub="Not the pixels \u2014 the text itself.\nAbout 20 milliseconds.", scan_y=y))
    durations.append(70)

# --- 3. bars land, one at a time ---------------------------------------
for i in range(1, 8):
    frames.append(frame(i, "It reads the page\nbefore it captures it.",
                        sub="Not the pixels \u2014 the text itself.\nAbout 20 milliseconds.", count=i))
    durations.append(130)

# --- 4. the payoff ------------------------------------------------------
after = frame(7, "Covered before\nyou ever saw it.",
              sub="You uncover what you want seen.\nNot the other way round.", count=7, ring=True)
hold(after, 90, 22)

# --- 5. outro -----------------------------------------------------------
outro = frame(7, "Blackbar", sub="Redact screenshots. Entirely on your device.", outro=True)
hold(outro, 90, 16)

out = "/home/claude/blackbar/store/blackbar-demo.gif"
frames[0].save(
    out, save_all=True, append_images=frames[1:], duration=durations,
    loop=0, optimize=True, disposal=2,
)

import os
total = sum(durations) / 1000
print(f"{out}")
print(f"  {len(frames)} frames  |  {total:.1f}s loop  |  {W}x{H}  |  {os.path.getsize(out)/1024:.0f} KB")
