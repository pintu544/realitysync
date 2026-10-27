# Slice 6 eval fixture generator (PIL). Style matches the Slice 1 probe
# image (spec/probe-shelf.png): wood-plank shelf background, cardboard
# boxes with a horizontal tape line, optional centered labels. All
# fixtures are synthetic with KNOWN ground truth — they measure SAM on
# synthetic content, never real-shelf accuracy. Run: python3 gen-fixtures.py
# Output: spec/eval/*.png + spec/eval/frames/<clip>/*.png (ffmpeg encodes
# the clips; see the shell commands printed at the end).
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = HERE
FRAMES = os.path.join(HERE, "frames")
W, H = 1200, 800
FONT = ImageFont.load_default()

CARDBOARD = (196, 154, 108)
CARDBOARD_DARK = (160, 122, 80)
TAPE = (222, 205, 160)
PLANK = (141, 103, 66)
PLANK_DARK = (120, 88, 56)
LABEL = (245, 242, 235)


def shelf_bg(draw, w, h):
    draw.rectangle([0, 0, w, h], fill=(90, 64, 40))
    plank_h = h // 4
    for r in range(4):
        y0 = r * plank_h
        fill = PLANK if r % 2 == 0 else PLANK_DARK
        draw.rectangle([0, y0, w, y0 + plank_h - 6], fill=fill)
        draw.rectangle([0, y0 + plank_h - 6, w, y0 + plank_h], fill=(60, 42, 26))


def box(draw, x, y, w, h, labeled=False):
    draw.rectangle([x, y, x + w, y + h], fill=CARDBOARD, outline=CARDBOARD_DARK, width=3)
    # Horizontal tape line across the middle (the Slice 3 split artifact).
    ty = y + h // 2
    draw.rectangle([x, ty - 3, x + w, ty + 3], fill=TAPE)
    if labeled:
        lw, lh = min(w - 20, 120), min(h // 3, 60)
        lx, ly = x + (w - lw) // 2, y + (h - lh) // 2
        draw.rectangle([lx, ly, lx + lw, ly + lh], fill=LABEL, outline=(180, 170, 150))
        draw.line([lx + 10, ly + lh // 2, lx + lw - 10, ly + lh // 2], fill=(120, 110, 95), width=2)


def save(img, name):
    p = os.path.join(OUT, name)
    img.save(p)
    print(f"wrote {name} {img.size}")


def img_with(boxes):
    img = Image.new("RGB", (W, H), (90, 64, 40))
    d = ImageDraw.Draw(img)
    shelf_bg(d, W, H)
    for (x, y, w, h, labeled) in boxes:
        box(d, x, y, w, h, labeled)
    return img


# --- Slice 6 watch-item fixtures ---------------------------------------
# W2 stacking ambiguity: 3 boxes, same x-extent, 5px vertical gaps.
save(img_with([(400, 80, 400, 200, False), (400, 285, 400, 200, False), (400, 490, 400, 200, False)]),
     "stacked-row.png")
save(img_with([(400, 80, 400, 200, True), (400, 285, 400, 200, True), (400, 490, 400, 200, True)]),
     "stacked-labeled.png")
# W7 small-box threshold: 30x30 = 900px^2 < 960px^2 filter threshold.
save(img_with([(585, 385, 30, 30, False)]), "small-single.png")
# Small boxes, sparse vs dense (separates size from density).
save(img_with([(150, 150, 60, 60, False), (500, 150, 60, 60, False),
               (850, 150, 60, 60, False), (500, 500, 60, 60, False)]), "small-sparse.png")
save(img_with([(x, y, 60, 60, False)
               for y in (150, 230)
               for x in (150, 230, 310, 390, 470, 550)]), "small-dense.png")
# Dense-row question (Slice 5 miss): 12 boxes, 6 per row, ~135px wide.
save(img_with([(x, y, 135, 200, False)
               for y in (120, 360)
               for x in (60, 225, 390, 555, 720, 885)]), "dense-12.png")
# Same density, larger boxes (~190px) — separates size from density.
save(img_with([(x, y, 190, 220, False)
               for y in (120, 380)
               for x in (20, 220, 420, 620, 820, 1020)]), "dense-large.png")
# Same count, sparse layout (3 rows of 4).
save(img_with([(x, y, 200, 200, False)
               for y in (80, 300, 520)
               for x in (80, 330, 580, 830)]), "sparse-12.png")
# Same dense layout, labeled (texture/contrast variant).
save(img_with([(x, y, 135, 200, True)
               for y in (120, 360)
               for x in (60, 225, 390, 555, 720, 885)]), "labeled-12.png")

# --- Video clip frame sequences (10fps, 40 frames) ----------------------
# Wide shelf canvas: 6 labeled boxes across 2400px.
def wide_shelf(width):
    img = Image.new("RGB", (width, H), (90, 64, 40))
    d = ImageDraw.Draw(img)
    shelf_bg(d, width, H)
    for i, x in enumerate(range(100, 2300, 380)):
        box(d, x, 250, 300, 320, labeled=True)
    return img


def write_clip(name, frame_fn, n=40):
    d = os.path.join(FRAMES, name)
    os.makedirs(d, exist_ok=True)
    for f in range(n):
        frame_fn(f).save(os.path.join(d, f"frame_{f:02d}.png"))
    print(f"wrote {n} frames for {name}")


WIDE = wide_shelf(2400)
# Slow pan: crop window slides 0 -> 1200 across the wide shelf.
write_clip("shelf-pan", lambda f: WIDE.crop((f * 1200 // 39, 0, f * 1200 // 39 + 1200, H)))
# Pan + moving occluder bar: a dark vertical bar slides across the frame.
def pan_bar(f):
    frame = WIDE.crop((f * 1200 // 39, 0, f * 1200 // 39 + 1200, H)).copy()
    d = ImageDraw.Draw(frame)
    bx = (f * 1400 // 39) - 100
    d.rectangle([bx, 0, bx + 90, H], fill=(40, 32, 24))
    return frame
write_clip("shelf-pan-bar", pan_bar)
# Static: same frame 40 times.
static = WIDE.crop((300, 0, 1500, H))
write_clip("shelf-static", lambda f: static.copy())
# Pan-past: shelf occupies the left 1200px of a 3600px canvas, empty
# planks beyond; the window slides 0 -> 2400, so boxes exit mid-clip
# (trailing-dropout test for the Slice 6 denominator decision).
past = Image.new("RGB", (3600, H), (90, 64, 40))
pd = ImageDraw.Draw(past)
shelf_bg(pd, 3600, H)
for x in (100, 480, 860):
    box(pd, x, 80, 300, 300, labeled=True)
# Second row, also left half only.
for x in (250, 630, 1010):
    box(pd, x, 450, 300, 300, labeled=True)
write_clip("shelf-pan-past", lambda f: past.crop((f * 2400 // 39, 0, f * 2400 // 39 + 1200, H)))

print("Encode with: for c in shelf-pan shelf-pan-bar shelf-static shelf-pan-past; do "
      "ffmpeg -y -framerate 10 -i spec/eval/frames/$c/frame_%02d.png "
      "-c:v libx264 -pix_fmt yuv420p spec/eval/$c.mp4; done")
