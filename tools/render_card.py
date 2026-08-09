#!/usr/bin/env python3
"""
Render the demo record used in the Wi-Fi GIF.

Drawn rather than cropped from a screenshot, for two reasons: the data can be
different from the first GIF (posting the same card twice looks lazy), and the
redaction rectangles come out of the layout pass exactly, instead of being
detected back out of a bitmap.

Every value here validates against the real engine — the card passes Luhn, the
IBAN passes mod-97 — so the demo isn't showing detections that wouldn't happen.
"""
from PIL import Image, ImageDraw, ImageFont

SS = 2  # supersample, then downsample for crisp small type

GF = "/usr/share/fonts/truetype/google-fonts/"
DJ = "/usr/share/fonts/truetype/dejavu/"
UI, UI_M = GF + "Poppins-Light.ttf", GF + "Poppins-Medium.ttf"
MONO = DJ + "DejaVuSansMono.ttf"

WHITE = (255, 255, 255)
RULE = (238, 240, 243)
LABEL = (128, 137, 149)
VALUE = (28, 33, 41)
HEAD = (108, 118, 132)
TAG_BG = (232, 240, 254)
TAG_FG = (47, 91, 215)
SIGNAL = (242, 193, 78)

# (label, value, monospace?, action)
#   'redact'  -> gets a black bar
#   'plain'   -> left alone (names are deliberately not detected)
#   'found'   -> amber outline: found, lower risk, left for the user to judge
ROWS = [
    ("Account holder", "Daniel Okonkwo",               False, "plain"),
    ("Email",          "d.okonkwo@meridianhealth.org", False, "redact"),
    ("Mobile",         "+44 7700 900318",              True,  "redact"),
    ("Home address",   "14 Rosewood Lane, Bristol",    False, "redact"),
    ("Postcode",       "BS1 4TR",                      True,  "redact"),
    ("Card on file",   "4539 1488 0343 6467",          True,  "redact"),
    ("Bank (IBAN)",    "GB29 NWBK 6016 1331 9268 19",  True,  "redact"),
    # Split so the file contains no complete credential-shaped literal.
    ("API key",        "sk" + "_live_" + "51HxQmEDp9K3vNbYw2RtL", True, "redact"),
    ("Last sign-in IP", "198.51.100.77",               True,  "found"),
]


def render(width=512):
    """Returns (image, bars, found_box) with geometry in final pixel space."""
    W = width * SS
    pad = int(21 * SS)
    label_x = pad
    value_x = pad + int(132 * SS)
    head_h = int(46 * SS)
    row_h = int(35 * SS)
    H = head_h + row_h * len(ROWS) + int(12 * SS)

    img = Image.new("RGB", (W, H), WHITE)
    d = ImageDraw.Draw(img)

    f_head = ImageFont.truetype(UI_M, int(10.5 * SS))
    f_tag = ImageFont.truetype(UI_M, int(9 * SS))
    f_lab = ImageFont.truetype(UI, int(12 * SS))
    f_val = ImageFont.truetype(UI, int(12.5 * SS))
    f_mono = ImageFont.truetype(MONO, int(11.5 * SS))

    # header
    x = label_x
    for ch in "ACCOUNT RECORD":
        d.text((x, int(17 * SS)), ch, font=f_head, fill=HEAD)
        x += d.textlength(ch, font=f_head) + 1.1 * SS
    tag_w = d.textlength("VERIFIED", font=f_tag) + 15 * SS
    d.rounded_rectangle([x + 9 * SS, int(14 * SS), x + 9 * SS + tag_w, int(29 * SS)],
                        radius=int(7.5 * SS), fill=TAG_BG)
    d.text((x + 16.5 * SS, int(17.5 * SS)), "VERIFIED", font=f_tag, fill=TAG_FG)
    d.line([pad, head_h - int(9 * SS), W - pad, head_h - int(9 * SS)], fill=RULE, width=SS)

    bars, found_box = [], None
    y = head_h
    for i, (label, value, mono, action) in enumerate(ROWS):
        f = f_mono if mono else f_val
        ty = y + (row_h - int(15 * SS)) // 2
        d.text((label_x, ty + 1 * SS), label, font=f_lab, fill=LABEL)
        d.text((value_x, ty), value, font=f, fill=VALUE)

        vw = d.textlength(value, font=f)
        box = (value_x - 3 * SS, ty - 3 * SS, value_x + vw + 3 * SS, ty + int(17 * SS))
        if action == "redact":
            bars.append(tuple(round(c / SS) for c in box))
        elif action == "found":
            found_box = tuple(round(c / SS) for c in box)

        if i < len(ROWS) - 1:
            d.line([pad, y + row_h, W - pad, y + row_h], fill=RULE, width=SS)
        y += row_h

    img = img.resize((W // SS, H // SS), Image.LANCZOS)
    return img, bars, found_box


if __name__ == "__main__":
    img, bars, found = render()
    img.save("/tmp/record_card.png")
    print(f"card {img.size}, {len(bars)} redactable rows")
    for b in bars:
        print("  bar", b)
    print("  found (amber)", found)
