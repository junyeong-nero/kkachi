# Lift the magpie off icon-b's flat ink background (color-to-alpha) and lay it on other backgrounds.
import sys
import numpy as np
from PIL import Image, ImageDraw

SRC = sys.argv[1]
BG = np.array([22, 24, 28], dtype=np.float64)

px = np.asarray(Image.open(SRC).convert("RGB"), dtype=np.float64)
# minimal alpha so that px = a*fg + (1-a)*BG with fg inside the RGB cube
below = np.where(px < BG, (BG - px) / BG, 0)
above = np.where(px > BG, (px - BG) / (255 - BG), 0)
alpha = np.clip(np.maximum(below, above).max(axis=2), 0, 1)
# Only the anti-aliased rim next to the background is partly transparent; the inside of the bird is
# opaque (otherwise the dark teal wing, close to the ink, would be treated as see-through).
from PIL import ImageFilter
# Background = ink-colored pixels connected to the corner. Anti-aliased pixels on the black/white
# boundaries inside the bird can also come out ink-colored; they are not background.
bg_like = Image.fromarray(((np.abs(px - BG).max(axis=2) <= 3) * 255).astype(np.uint8)).copy()  # writable
ImageDraw.floodfill(bg_like, (0, 0), 128)
is_bg = Image.fromarray(((np.asarray(bg_like) == 128) * 255).astype(np.uint8))
near_bg = np.asarray(is_bg.filter(ImageFilter.MaxFilter(7))) > 0
# The generator left a dark ring (darker than the ink) where white parts meet the background, e.g.
# under the belly. On ink it was invisible; on a light background it reads as a gray line. Drop it.
bright = Image.fromarray(((px.min(axis=2) > 180) * 255).astype(np.uint8))
near_bright = np.asarray(bright.filter(ImageFilter.MaxFilter(5))) > 0
# (pure black is the bird's own body and stays)
ring = near_bg & near_bright & (px.max(axis=2) < BG.min() - 2) & (px.min(axis=2) > 0)
alpha = np.where(near_bg, alpha, 1.0)
alpha = np.where(ring, 0.0, alpha)[..., None]


def on(color):
    c = np.array(color, dtype=np.float64)
    return Image.fromarray(np.clip(px + (1 - alpha) * (c - BG), 0, 255).round().astype(np.uint8))


if __name__ == "__main__":
    if sys.argv[2] == "sheet":
        cands = {
            "mist": (236, 240, 243), "mint": (206, 232, 226), "sky": (190, 216, 240),
            "sand": (238, 228, 210), "slate": (96, 112, 128), "teal": (40, 150, 140),
        }
        tiles = []
        for name, col in cands.items():
            im = on(col).resize((300, 300), Image.LANCZOS)
            # iOS-like rounded mask and a small version as it appears on the home screen
            mask = Image.new("L", (300, 300), 0); ImageDraw.Draw(mask).rounded_rectangle((0, 0, 299, 299), 66, fill=255)
            tile = Image.new("RGB", (330, 420), (250, 250, 250)); tile.paste(im, (15, 15), mask)
            small = on(col).resize((60, 60), Image.LANCZOS); tile.paste(small, (15, 335))
            dark = Image.new("RGB", (80, 80), (30, 30, 34)); dark.paste(small, (10, 10)); tile.paste(dark, (95, 325))
            ImageDraw.Draw(tile).text((190, 360), name, fill=(40, 40, 40))
            tiles.append(tile)
        sheet = Image.new("RGB", (330 * 3, 420 * 2), (250, 250, 250))
        for i, t in enumerate(tiles): sheet.paste(t, ((i % 3) * 330, (i // 3) * 420))
        sheet.save(sys.argv[3])
    else:  # out <r,g,b> <path>
        on(tuple(int(v) for v in sys.argv[3].split(","))).save(sys.argv[4])
