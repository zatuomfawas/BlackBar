#!/usr/bin/env python3
"""
Build store screenshots 3-5 from real captures.

Everything visual here comes from actual product pixels — the ledger, the
status bar, the demo page — because a fabricated screenshot of software is
both against store policy and a promise you have to keep later.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter

GRAPHITE=(28,27,25); MAT=(19,18,16); LINE=(58,54,46); BONE=(237,233,224)
MUTE=(142,138,126); DIM=(110,107,99); SIGNAL=(242,193,78); SAFE=(143,185,150)
GF="/usr/share/fonts/truetype/google-fonts/"; DJ="/usr/share/fonts/truetype/dejavu/"
POP_M, POP_L, MONO, MONO_B = GF+"Poppins-Medium.ttf", GF+"Poppins-Light.ttf", DJ+"DejaVuSansMono.ttf", DJ+"DejaVuSansMono-Bold.ttf"
W, H, SS, M = 1280, 800, 3, 40
OUT = "store/screenshots/"


class Text:
    """Type is drawn at 3x on an overlay so it stays crisp over 1x screenshots."""
    def __init__(self):
        self.ov = Image.new("RGBA", (W*SS, H*SS), (0,0,0,0))
        self.d = ImageDraw.Draw(self.ov)
    def f(self, path, size): return ImageFont.truetype(path, int(size*SS))
    def at(self, xy, text, font, fill):
        self.d.text((xy[0]*SS, xy[1]*SS), text, font=font, fill=fill+(255,))
    def tracked(self, xy, text, font, fill, track=0):
        x, y = xy[0]*SS, xy[1]*SS
        for ch in text:
            self.d.text((x,y), ch, font=font, fill=fill+(255,))
            x += self.d.textlength(ch, font=font) + track*SS
    def width(self, text, font, track=0):
        return (sum(self.d.textlength(c, font=font) for c in text) + track*SS*(len(text)-1)) / SS
    def wrap(self, text, font, maxw):
        words, lines, cur = text.split(), [], ""
        for w_ in words:
            t = (cur + " " + w_).strip()
            if self.width(t, font) <= maxw: cur = t
            else: lines.append(cur); cur = w_
        if cur: lines.append(cur)
        return lines
    def paragraph(self, xy, text, font, fill, maxw, leading):
        x, y = xy
        for line in self.wrap(text, font, maxw):
            self.at((x, y), line, font, fill); y += leading
        return y
    def onto(self, canvas):
        return Image.alpha_composite(canvas.convert("RGBA"),
                                     self.ov.resize((W,H), Image.LANCZOS)).convert("RGB")


def base():
    return Image.new("RGB", (W,H), GRAPHITE)

def wordmark(canvas, t):
    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle([M, 38, M+30, 50], radius=2, fill=(0,0,0))
    d.rectangle([M, 48, M+30, 50], fill=SIGNAL)
    t.tracked((M+42, 35), "BLACKBAR", t.f(POP_M,15), BONE, 2.2)

def footer(canvas, t, text, dot=SAFE):
    f = t.f(MONO, 11.5)
    w = t.width(text, f, 1.4)
    t.d.ellipse([((W-w)/2-20)*SS, 733*SS, ((W-w)/2-13)*SS, 740*SS], fill=dot+(255,))
    t.tracked(((W-w)/2, 730), text, f, MUTE, 1.4)


# ----------------------------------------------------------------- shot 3
def shot_detection():
    canvas, t = base(), Text()
    wordmark(canvas, t)

    ledger = Image.open('/tmp/ledger.png')
    ph = 616
    pw = round(ledger.width * ph / ledger.height)
    px = W - M - pw
    canvas.paste(ledger.resize((pw, ph), Image.LANCZOS), (px, 116))
    ImageDraw.Draw(canvas).rectangle([px-1, 115, px+pw, 116+ph], outline=LINE, width=1)

    colw = px - M - 56
    t.at((M, 100), "It knows what a", t.f(POP_M,40), BONE)
    t.at((M, 150), "secret looks like.", t.f(POP_M,40), BONE)

    y = t.paragraph((M, 232),
        "Card numbers are checksum-verified. IBANs are validated with mod-97. "
        "Unlabelled strings are scored for entropy before they're flagged.",
        t.f(POP_L,16.5), MUTE, colw, 27)

    t.paragraph((M, y+18),
        "It reads the page rather than the pixels, so the coordinates are exact "
        "and there's no OCR guessing a 1 for an l.",
        t.f(POP_L,16.5), DIM, colw, 27)

    stats = [("24", "detection rules"), ("~20ms", "to scan a page"), ("0", "bytes uploaded")]
    sx = M
    for value, label in stats:
        t.at((sx, 470), value, t.f(POP_M,30), SIGNAL if value=="0" else BONE)
        t.tracked((sx, 512), label.upper(), t.f(MONO,10), MUTE, 1.3)
        sx += 190
    ImageDraw.Draw(canvas).line([(M,452),(M+colw,452)], fill=LINE, width=1)

    t.tracked((M, 580), "WHAT IT WON'T CLAIM", t.f(MONO,10), MUTE, 1.6)
    t.paragraph((M, 604),
        "No face detection. No guessing which words are someone's name. "
        "A detector that's wrong half the time teaches you to ignore it.",
        t.f(POP_L,15), DIM, colw, 24)

    footer(canvas, t, "EVERY RULE RUNS ON YOUR DEVICE")
    return t.onto(canvas)


# ----------------------------------------------------------------- shot 4
def shot_trust():
    canvas, t = base(), Text()
    wordmark(canvas, t)
    d = ImageDraw.Draw(canvas)

    t.at((M, 100), "It tried to reach the network.", t.f(POP_M,38), BONE)
    t.at((M, 148), "Its own policy stopped it.", t.f(POP_M,38), BONE)

    t.paragraph((M, 226),
        "Blackbar ships with connect-src 'none'. Chrome refuses every connection "
        "it attempts — that isn't a promise we're making, it's a rule the browser "
        "enforces on us. The editor runs the test each time it opens.",
        t.f(POP_L,16.5), MUTE, 640, 27)

    # real status bar pixels
    status = Image.open('/tmp/statusbar.png').crop((0,0,470,42))
    sw = 700; sh = round(status.height * sw / status.width)
    canvas.paste(status.resize((sw,sh), Image.LANCZOS), (M, 372))
    d.rectangle([M-1, 371, M+sw, 372+sh], outline=LINE, width=1)
    t.tracked((M, 348), "LIVE, IN THE EDITOR'S STATUS BAR", t.f(MONO,10), MUTE, 1.6)

    # the manifest line that makes it true
    cx, cy, cw, chh = M, 470, 700, 132
    d.rounded_rectangle([cx, cy, cx+cw, cy+chh], radius=8, fill=MAT, outline=LINE, width=1)
    t.tracked((cx+18, cy+16), "MANIFEST.JSON", t.f(MONO,9.5), DIM, 1.4)
    t.at((cx+18, cy+42), '"content_security_policy": {', t.f(MONO,13), MUTE)
    t.at((cx+34, cy+66), '"extension_pages":', t.f(MONO,13), MUTE)
    t.at((cx+34, cy+90), "\"connect-src 'none'\"", t.f(MONO,13), SIGNAL)

    # permissions column
    rx = M + 760
    t.tracked((rx, 348), "WHAT INSTALLING ASKS FOR", t.f(MONO,10), MUTE, 1.6)
    items = [("One tab", "only when you press the shortcut"),
             ("Local storage", "your settings, on your machine"),
             ("Nothing else", "no host permissions, no history, no identity")]
    iy = 380
    for title, sub in items:
        d.ellipse([rx, iy+7, rx+7, iy+14], fill=SAFE)
        t.at((rx+18, iy), title, t.f(POP_M,16), BONE)
        for line in t.wrap(sub, t.f(POP_L,13.5), 400):
            iy += 22
            t.at((rx+18, iy), line, t.f(POP_L,13.5), DIM)
        iy += 44

    footer(canvas, t, "TURN OFF YOUR WI-FI AND IT ALL STILL WORKS")
    return t.onto(canvas)


# ----------------------------------------------------------------- shot 5
def shot_blur():
    canvas, t = base(), Text()
    wordmark(canvas, t)
    d = ImageDraw.Draw(canvas)

    t.at((M, 100), "Blur is a look.", t.f(POP_M,40), BONE)
    t.at((M, 150), "A black bar is a fact.", t.f(POP_M,40), BONE)

    t.paragraph((M, 232),
        "Pixelated text has been recovered by brute-force re-rendering for years. "
        "Blackbar offers blur and pixelation because people ask for them — and "
        "refuses to count either as safe.",
        t.f(POP_L,16.5), MUTE, 760, 27)

    row = Image.open('/tmp/cardrow.png').convert("RGB")
    rw = 620; rh = round(row.height * rw / row.width)

    def panel(y, img, label, note, accent):
        d.rectangle([M-1, y-1, M+rw, y+rh], outline=LINE, width=1)
        canvas.paste(img.resize((rw,rh), Image.LANCZOS), (M, y))
        t.tracked((M+rw+40, y+2), label, t.f(MONO,10.5), accent, 1.5)
        t.at((M+rw+40, y+22), note, t.f(POP_L,14.5), DIM)

    # 1. untouched
    panel(346, row, "UNTOUCHED", "Readable by anyone you send it to.", MUTE)

    # 2. pixelated — a real pixelation of the same pixels
    blocks = row.resize((row.width//9, row.height//9), Image.BILINEAR) \
                .resize(row.size, Image.NEAREST)
    panel(430, blocks, "PIXELATED", "Reversible. The digits are still in there.", SIGNAL)

    # 3. black bar — the pixels are gone
    bar = row.copy()
    ImageDraw.Draw(bar).rectangle([155, 6, 600, row.height-8], fill=(0,0,0))
    panel(514, bar, "BLACK BAR", "Destroyed, then flattened on export.", SAFE)

    t.paragraph((M, 626),
        "Only a black bar counts toward \"clear\" in the status line. "
        "Saying so costs us a feature bullet and buys you the thing you came for.",
        t.f(POP_L,15), MUTE, 900, 24)

    footer(canvas, t, "EXPORTS ARE FLATTENED — NO LAYER TO PEEL OFF, NO METADATA")
    return t.onto(canvas)


if __name__ == "__main__":
    for name, fn in [("screenshot-3-detection", shot_detection),
                     ("screenshot-4-trust", shot_trust),
                     ("screenshot-5-blur", shot_blur)]:
        img = fn()
        path = f"{OUT}{name}-1280x800.png"
        img.save(path)
        print(f"{path}  {img.size}  {img.mode}")
