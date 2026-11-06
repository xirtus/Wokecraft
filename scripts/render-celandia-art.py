#!/usr/bin/env python3
"""
Celandia: Wokecraft NoW — Generative Art & High-Craft UI Texture Baker
Generates BLP2 textures directly from Celandia — The Elsewhere Tide's generative
concept paintings, character sheets, and Bricolage Grotesque / Geist Sans typography.
Licensed under GNU GPLv3 (GPL-3.0-or-later) — Owned by XIRTUS.
"""

import os
import struct
import math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "WoW" / "Data"
CELANDIA_DIR = Path("/Users/xmacbookm5/Projects/j3games/Celandia")
ART_DIR = CELANDIA_DIR / "docs" / "elsewhere-tide" / "art"
IMG_DIR = CELANDIA_DIR / "docs" / "images"
DISPLAY_FONT_PATH = CELANDIA_DIR / "docs" / "elsewhere-tide" / "fonts" / "bricolage-grotesque-variable.ttf"
GEIST_DIR = Path("/Users/xmacbookm5/Projects/curricula/open_notebook/curriculum/assets")

# Celandia — The Elsewhere Tide exact design tokens (from game.css & fairy-punk.css)
INK_DEEP = (20, 12, 28, 255)        # #140c1c
PLUM_DARK = (33, 21, 45, 255)       # #21152d
PLUM_PANEL = (40, 26, 54, 242)      # #281a36
PAPER_WARM = (255, 243, 227, 255)   # #fff3e3
INK_SOFT = (232, 215, 200, 255)     # #e8d7c8
GOLD_AUREATE = (255, 226, 138, 255) # #ffe28a
BRASS_ANTIQUE = (215, 167, 72, 255) # #d7a748
BRASS_DARK = (128, 92, 36, 255)
PINK_BLOSSOM = (255, 155, 209, 255) # #ff9bd1
CYAN_SEAFOAM = (145, 238, 233, 255) # #91eee9
LILAC_MIST = (206, 180, 255, 255)   # #ceb4ff


def load_font(kind="display", size=24):
    candidates = []
    if kind == "display":
        candidates.extend([
            DISPLAY_FONT_PATH,
            GEIST_DIR / "Geist-Bold.ttf",
            DATA_DIR / "Fonts" / "MORPHEUS.TTF",
        ])
    elif kind == "bold":
        candidates.extend([
            GEIST_DIR / "Geist-Bold.ttf",
            DISPLAY_FONT_PATH,
            DATA_DIR / "Fonts" / "FRIZQT__.TTF",
        ])
    else:
        candidates.extend([
            GEIST_DIR / "Geist-SemiBold.ttf",
            GEIST_DIR / "Geist-Medium.ttf",
            DATA_DIR / "Fonts" / "ARIALN.TTF",
        ])
    for p in candidates:
        if p and Path(p).exists():
            try:
                return ImageFont.truetype(str(p), size)
            except Exception:
                pass
    return ImageFont.load_default()


def write_blp2(rel_path: str, img: Image.Image):
    """Write an RGBA PIL Image as an uncompressed BLP2 (compression=3, RAW3 BGRA) file."""
    rgba = img.convert("RGBA")
    w, h = rgba.size
    arr = np.array(rgba, dtype=np.uint8)
    # Convert RGBA -> BGRA for BLP2 RAW3
    bgra = arr[:, :, [2, 1, 0, 3]].tobytes()

    header = bytearray(148)
    header[0:4] = b"BLP2"
    struct.pack_into("<I", header, 4, 1)    # version = 1
    header[8] = 3                           # compression = 3 (uncompressed BGRA)
    header[9] = 8                           # alpha depth = 8
    header[10] = 0                          # alpha encoding
    header[11] = 0                          # has mips = 0
    struct.pack_into("<I", header, 12, w)
    struct.pack_into("<I", header, 16, h)
    struct.pack_into("<I", header, 20, 148) # mip[0] offset
    struct.pack_into("<I", header, 84, len(bgra)) # mip[0] length

    full_path = DATA_DIR / rel_path.replace("\\", "/")
    full_path.parent.mkdir(parents=True, exist_ok=True)
    with open(full_path, "wb") as f:
        f.write(header)
        f.write(bgra)


def load_art_image(filename: str, fallback_color=(42, 28, 58)) -> Image.Image:
    for folder in (ART_DIR, IMG_DIR):
        p = folder / filename
        if p.exists():
            return Image.open(p).convert("RGBA")
    return Image.new("RGBA", (1024, 1024), (*fallback_color, 255))


def crop_aspect(img: Image.Image, target_w: int, target_h: int, focus_y: float = 0.45) -> Image.Image:
    w, h = img.size
    target_ratio = target_w / target_h
    src_ratio = w / h
    if src_ratio > target_ratio:
        new_w = int(h * target_ratio)
        x0 = (w - new_w) // 2
        cropped = img.crop((x0, 0, x0 + new_w, h))
    else:
        new_h = int(w / target_ratio)
        y0 = int(max(0, min(h - new_h, (h - new_h) * focus_y)))
        cropped = img.crop((0, y0, w, y0 + new_h))
    return cropped.resize((target_w, target_h), Image.Resampling.LANCZOS)


def extract_portrait_cell(
    sheet: Image.Image,
    cx: int,
    cy: int,
    crop_size: int,
    cell_size: int,
    bg_tint: tuple,
    ring_color: tuple,
    badge_color: tuple = None,
) -> Image.Image:
    """
    Crops a character bust from a Celandia concept sheet, replaces the neutral studio parchment
    backdrop with a rich Celandia twilight radial vignette, and frames it in an ornate brass
    and porcelain border suitable for 48x48 and 64x64 UI buttons.
    """
    w, h = sheet.size
    half = crop_size // 2
    x0 = max(0, cx - half)
    y0 = max(0, cy - half)
    x1 = min(w, x0 + crop_size)
    y1 = min(h, y0 + crop_size)
    sub = sheet.crop((x0, y0, x1, y1)).resize((cell_size, cell_size), Image.Resampling.LANCZOS)

    arr = np.array(sub, dtype=np.float32)
    # Sample top-left & top-right corners to estimate parchment paper color
    c1 = arr[2:8, 2:8, :3].mean(axis=(0, 1))
    c2 = arr[2:8, -8:-2, :3].mean(axis=(0, 1))
    bg_ref = 0.5 * (c1 + c2)

    diff = np.linalg.norm(arr[:, :, :3] - bg_ref[None, None, :], axis=2)
    # Soft matte mask: 0.0 on studio paper, 1.0 on character linework & colors
    fg_mask = np.clip((diff - 16.0) / 28.0, 0.0, 1.0)

    yy, xx = np.mgrid[0:cell_size, 0:cell_size]
    nx = (xx - cell_size * 0.5) / (cell_size * 0.5)
    ny = (yy - cell_size * 0.5) / (cell_size * 0.5)
    rad = np.sqrt(nx * nx + ny * ny)

    # Rich Celandia twilight glow backdrop
    bg = np.zeros((cell_size, cell_size, 4), dtype=np.float32)
    glow = np.clip(1.0 - rad * 0.85, 0.0, 1.0)
    for c in range(3):
        bg[:, :, c] = PLUM_DARK[c] * (1.0 - glow * 0.65) + bg_tint[c] * (glow * 0.85)
    bg[:, :, 3] = 255.0

    # Composite character bust over twilight glow
    out = np.zeros_like(arr)
    for c in range(3):
        out[:, :, c] = bg[:, :, c] * (1.0 - fg_mask) + arr[:, :, c] * fg_mask
    out[:, :, 3] = 255.0

    img = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")
    img = ImageEnhance.Contrast(img).enhance(1.12)
    img = ImageEnhance.Color(img).enhance(1.15)

    draw = ImageDraw.Draw(img)
    # Outer dark ink edge + ornate double brass/accent border
    m = 2
    draw.rectangle([0, 0, cell_size - 1, cell_size - 1], outline=INK_DEEP, width=2)
    draw.rectangle([m, m, cell_size - 1 - m, cell_size - 1 - m], outline=BRASS_ANTIQUE, width=2)
    draw.rectangle([m + 3, m + 3, cell_size - 4 - m, cell_size - 4 - m], outline=(*ring_color[:3], 190), width=1)

    # Corner porcelain filigree diamonds
    for px_c, py_c in [(6, 6), (cell_size - 7, 6), (6, cell_size - 7), (cell_size - 7, cell_size - 7)]:
        draw.polygon([(px_c, py_c - 3), (px_c + 3, py_c), (px_c, py_c + 3), (px_c - 3, py_c)], fill=GOLD_AUREATE)

    if badge_color is not None:
        # Subtle top glow bar indicating Kingdom affinity
        draw.line([(8, 5), (cell_size - 9, 5)], fill=badge_color, width=2)

    return img


def build_logo_textures():
    """
    Generates:
    - Interface/Glues/Common/Glues-WoW-Logo.blp (256x128)
    - Interface/Glues/MainMenu/Glues-XirtusLogo.blp (128x128)
    - Interface/Glues/MainMenu/Glues-BlizzardLogo.blp (128x128)
    """
    # 1. Glues-WoW-Logo.blp (256x128) — Rendered at 2x (512x256) and downsampled with LANCZOS
    W, H = 512, 256
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    cx, cy = W // 2, H // 2 - 4

    # Soft radial twilight aura behind cartouche
    arr = np.array(canvas, dtype=np.float32)
    yy, xx = np.mgrid[0:H, 0:W]
    dx = (xx - cx) / 220.0
    dy = (yy - cy) / 96.0
    d = np.sqrt(dx * dx + dy * dy)
    aura = np.clip(1.0 - d, 0.0, 1.0) ** 1.8
    arr[:, :, 0] = 33.0 * (1.0 - aura * 0.4) + 115.0 * (aura * 0.4)
    arr[:, :, 1] = 21.0 * (1.0 - aura * 0.4) + 65.0 * (aura * 0.4)
    arr[:, :, 2] = 45.0 * (1.0 - aura * 0.4) + 135.0 * (aura * 0.4)
    arr[:, :, 3] = np.clip(aura * 225.0, 0.0, 225.0)
    canvas = Image.fromarray(arr.astype(np.uint8), "RGBA")
    draw = ImageDraw.Draw(canvas)

    # Ornate Celandia Sundial & Compass Rays behind the crest
    for i in range(16):
        ang = i * (math.pi / 8.0)
        r_in = 38
        r_out = 96 if i % 2 == 0 else 68
        x1 = cx + math.cos(ang) * r_in
        y1 = (cy - 22) + math.sin(ang) * (r_in * 0.72)
        x2 = cx + math.cos(ang) * r_out
        y2 = (cy - 22) + math.sin(ang) * (r_out * 0.72)
        col = GOLD_AUREATE if i % 2 == 0 else CYAN_SEAFOAM
        draw.line([(x1, y1), (x2, y2)], fill=(*col[:3], 180), width=3 if i % 2 == 0 else 2)

    # Porcelain-and-brass cartouche plaque
    plaque_box = [28, 34, W - 28, H - 36]
    draw.rounded_rectangle(plaque_box, radius=36, fill=(26, 16, 38, 242), outline=BRASS_ANTIQUE, width=5)
    inner_box = [36, 42, W - 36, H - 44]
    draw.rounded_rectangle(inner_box, radius=30, fill=(35, 22, 50, 245), outline=(*CYAN_SEAFOAM[:3], 185), width=2)

    # Top crown jewel / chronocompass dial
    draw.ellipse([cx - 28, 12, cx + 28, 68], fill=(30, 19, 44, 255), outline=GOLD_AUREATE, width=4)
    draw.ellipse([cx - 18, 22, cx + 18, 58], fill=(48, 30, 68, 255), outline=PINK_BLOSSOM, width=2)
    draw.polygon([(cx, 18), (cx + 8, 40), (cx, 62), (cx - 8, 40)], fill=GOLD_AUREATE)
    draw.polygon([(cx - 20, 40), (cx, 33), (cx + 20, 40), (cx, 47)], fill=CYAN_SEAFOAM)

    # Left & Right wing filigree flourishes
    for side in (-1, 1):
        bx = cx + side * 212
        draw.polygon([
            (bx, cy),
            (bx - side * 24, cy - 22),
            (bx - side * 12, cy),
            (bx - side * 24, cy + 22),
        ], fill=GOLD_AUREATE, outline=INK_DEEP)

    # Crisp Typography: "CELANDIA" eyebrow, "WOKECRAFT NoW" main title, "THE ELSEWHERE TIDE" ribbon
    f_eyebrow = load_font("bold", 23)
    f_main = load_font("display", 54)
    f_sub = load_font("bold", 20)

    def draw_centered_text(y_pos, text, font, fill, shadow=(12, 6, 18, 255), stroke_w=3):
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        tx = (W - tw) // 2
        draw.text((tx, y_pos + 3), text, font=font, fill=shadow, stroke_width=stroke_w, stroke_fill=shadow)
        draw.text((tx, y_pos), text, font=font, fill=fill, stroke_width=max(1, stroke_w - 1), stroke_fill=INK_DEEP)

    draw_centered_text(54, "C E L A N D I A", f_eyebrow, CYAN_SEAFOAM, stroke_w=3)
    draw_centered_text(86, "WOKECRAFT NoW", f_main, PAPER_WARM, stroke_w=4)

    # Bottom ribbon banner for "THE ELSEWHERE TIDE"
    rib_box = [96, 166, W - 96, 206]
    draw.rounded_rectangle(rib_box, radius=16, fill=(22, 14, 34, 255), outline=BRASS_ANTIQUE, width=3)
    draw_centered_text(173, "THE ELSEWHERE TIDE", f_sub, GOLD_AUREATE, stroke_w=2)

    logo_256 = canvas.resize((256, 128), Image.Resampling.LANCZOS)
    write_blp2("Interface/Glues/Common/Glues-WoW-Logo.blp", logo_256)

    # 2. Glues-XirtusLogo.blp (128x128) — Rendered at 256x256 and downsampled
    XW, XH = 256, 256
    xcanvas = Image.new("RGBA", (XW, XH), (0, 0, 0, 0))
    xdraw = ImageDraw.Draw(xcanvas)
    xc, yc = XW // 2, XH // 2

    xdraw.ellipse([22, 22, XW - 22, XH - 22], fill=(26, 16, 38, 235), outline=BRASS_ANTIQUE, width=5)
    xdraw.ellipse([34, 34, XW - 34, XH - 34], fill=(36, 22, 52, 240), outline=CYAN_SEAFOAM, width=2)
    # 8-point chronocompass star
    for i in range(8):
        ang = i * (math.pi / 4.0)
        r_out = 78 if i % 2 == 0 else 54
        x1 = xc + math.cos(ang) * 20
        y1 = yc - 14 + math.sin(ang) * 20
        x2 = xc + math.cos(ang) * r_out
        y2 = yc - 14 + math.sin(ang) * r_out
        xdraw.line([(x1, y1), (x2, y2)], fill=GOLD_AUREATE if i % 2 == 0 else PINK_BLOSSOM, width=4)
    xdraw.ellipse([xc - 22, yc - 36, xc + 22, yc + 8], fill=PLUM_DARK, outline=GOLD_AUREATE, width=3)

    fx_main = load_font("display", 36)
    fx_sub = load_font("bold", 18)
    xdraw.rounded_rectangle([26, 152, XW - 26, 206], radius=14, fill=(20, 12, 30, 250), outline=BRASS_ANTIQUE, width=3)
    bbox = xdraw.textbbox((0, 0), "XIRTUS", font=fx_main)
    xdraw.text(((XW - (bbox[2] - bbox[0])) // 2, 157), "XIRTUS", font=fx_main, fill=PAPER_WARM, stroke_width=2, stroke_fill=INK_DEEP)
    bbox2 = xdraw.textbbox((0, 0), "FOSS GPLv3", font=fx_sub)
    xdraw.text(((XW - (bbox2[2] - bbox2[0])) // 2, 212), "FOSS GPLv3", font=fx_sub, fill=GOLD_AUREATE, stroke_width=2, stroke_fill=INK_DEEP)

    xlogo_128 = xcanvas.resize((128, 128), Image.Resampling.LANCZOS)
    write_blp2("Interface/Glues/MainMenu/Glues-XirtusLogo.blp", xlogo_128)
    write_blp2("Interface/Glues/Mainmenu/Glues-XirtusLogo.blp", xlogo_128)


def build_character_sheets():
    """
    Generates:
    - Interface/Glues/CharacterCreate/UI-CharacterCreate-Classes.blp (512x512, 4x4 grid of 128x128)
    - Interface/Glues/CharacterCreate/UI-CharacterCreate-Races.blp (512x512, 4x4 grid of 128x128)
    - Interface/Glues/CharacterCreate/UI-CharacterCreate-Gender.blp (128x64, 2x1 grid of 64x64)
    - Interface/Glues/CharacterCreate/UI-CharacterCreate-Factions.blp (128x64, 2x1 grid of 64x64)
    - Interface/Glues/CharacterCreate/UI-CharacterCreate-Banners.blp (256x256)
    """
    crew_sheet = load_art_image("03-crew-locked.png")
    princess_sheet = load_art_image("08-four-princesses.png")
    riff_sheet = load_art_image("09-riff-and-daze-nature.png")
    serein_sheet = load_art_image("10-serein-conversation.png")

    # 1. UI-CharacterCreate-Classes.blp (512x512, 4x4 cells of 128x128)
    # Exact CLASS_ICON_TCOORDS mapping in glue/art.rs:
    # (0,0)=1 Warrior (Porcelain Duelist — Rook)
    # (1,0)=8 Mage (Elsewhere Tideweaver — Princess Serein)
    # (2,0)=4 Rogue (Shadow Skimmer — Mora)
    # (3,0)=11 Druid (Hushwood Keeper — Moss)
    # (0,1)=3 Hunter (Glasswake Ranger — Ilex)
    # (1,1)=7 Shaman (Stormglass Cantor — Fizz)
    # (2,1)=5 Priest (Frostbell Chorister — Riff)
    # (3,1)=9 Warlock (Nocturnum Hexer — Latch)
    # (0,2)=2 Paladin (Aureate Sovereign — Princess Avelune)
    classes_img = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    class_specs = [
        # (col, row, sheet, cx, cy, size, bg_tint, ring_color, icon_name)
        (0, 0, crew_sheet, 219, 175, 270, (215, 140, 175), PINK_BLOSSOM, "Class_PorcelainDuelist"),
        (1, 0, princess_sheet, 642, 205, 290, (110, 210, 235), CYAN_SEAFOAM, "Class_ElsewhereTideweaver"),
        (2, 0, crew_sheet, 530, 190, 270, (175, 120, 225), LILAC_MIST, "Class_ShadowSkimmer"),
        (3, 0, crew_sheet, 1887, 195, 290, (120, 205, 155), CYAN_SEAFOAM, "Class_HushwoodKeeper"),
        (0, 1, crew_sheet, 868, 178, 270, (110, 215, 195), CYAN_SEAFOAM, "Class_GlasswakeRanger"),
        (1, 1, crew_sheet, 1532, 225, 270, (125, 185, 245), CYAN_SEAFOAM, "Class_StormglassCantor"),
        (2, 1, riff_sheet, 457, 270, 350, (240, 215, 155), GOLD_AUREATE, "Class_FrostbellChorister"),
        (3, 1, crew_sheet, 1194, 180, 270, (185, 115, 230), LILAC_MIST, "Class_NocturnumHexer"),
        (0, 2, princess_sheet, 1539, 195, 290, (245, 195, 105), GOLD_AUREATE, "Class_AureateSovereign"),
    ]
    for col, row, sheet, cx, cy, sz, tint, ring, icon_name in class_specs:
        cell = extract_portrait_cell(sheet, cx, cy, sz, 128, tint, ring, badge_color=ring)
        classes_img.paste(cell, (col * 128, row * 128))
        # Also write 64x64 class icon to Interface/Icons/
        write_blp2(f"Interface/Icons/{icon_name}.blp", cell.resize((64, 64), Image.Resampling.LANCZOS))

    write_blp2("Interface/Glues/CharacterCreate/UI-CharacterCreate-Classes.blp", classes_img)

    # 2. UI-CharacterCreate-Races.blp (512x512, 4x4 cells of 128x128)
    # Exact RACE_ICON_TCOORDS in glue/art.rs:
    # Male rows (0..1):
    #   (0,0) = Race 1 (Porcelain Citizen)
    #   (1,0) = Race 3 (Frostbell Artisan)
    #   (2,0) = Race 7 (Sparkwright)
    #   (3,0) = Race 4 (Sylvan Sentinel)
    #   (0,1) = Race 6 (Woolly Warden)
    #   (1,1) = Race 5 (Hollowed Risen)
    #   (2,1) = Race 8 (Glasswake Nomad)
    #   (3,1) = Race 2 (Obsidian Vanguard)
    # Female rows (2..3): same columns at row + 2
    races_img = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    race_specs = [
        # Male Row 0 (Porcelain Court column)
        (0, 0, crew_sheet, 219, 175, 270, (225, 150, 185), PINK_BLOSSOM),
        (1, 0, riff_sheet, 457, 270, 350, (145, 220, 235), CYAN_SEAFOAM),
        (2, 0, crew_sheet, 1532, 225, 270, (245, 205, 120), GOLD_AUREATE),
        (3, 0, crew_sheet, 868, 178, 270, (135, 215, 175), CYAN_SEAFOAM),
        # Male Row 1 (Nocturnum / Wilds column)
        (0, 1, crew_sheet, 1887, 195, 290, (140, 200, 145), GOLD_AUREATE),
        (1, 1, crew_sheet, 1194, 180, 270, (175, 120, 225), LILAC_MIST),
        (2, 1, riff_sheet, 1020, 225, 350, (125, 215, 210), CYAN_SEAFOAM),
        (3, 1, crew_sheet, 530, 190, 270, (215, 130, 175), PINK_BLOSSOM),
        # Female Row 2 (Porcelain Court Princesses)
        (0, 2, princess_sheet, 224, 205, 290, (235, 155, 195), PINK_BLOSSOM),
        (1, 2, princess_sheet, 642, 205, 290, (135, 225, 240), CYAN_SEAFOAM),
        (2, 2, princess_sheet, 1091, 190, 290, (245, 205, 125), GOLD_AUREATE),
        (3, 2, princess_sheet, 1539, 195, 290, (255, 215, 130), GOLD_AUREATE),
        # Female Row 3 (Elsewhere & Nocturnum Heroines)
        (0, 3, serein_sheet, 430, 250, 360, (145, 220, 215), CYAN_SEAFOAM),
        (1, 3, serein_sheet, 1050, 250, 360, (185, 130, 235), LILAC_MIST),
        (2, 3, crew_sheet, 530, 190, 270, (225, 145, 195), PINK_BLOSSOM),
        (3, 3, princess_sheet, 1091, 190, 290, (235, 175, 120), GOLD_AUREATE),
    ]
    for col, row, sheet, cx, cy, sz, tint, ring in race_specs:
        cell = extract_portrait_cell(sheet, cx, cy, sz, 128, tint, ring)
        races_img.paste(cell, (col * 128, row * 128))

    write_blp2("Interface/Glues/CharacterCreate/UI-CharacterCreate-Races.blp", races_img)

    # 3. UI-CharacterCreate-Gender.blp (128x64: left 64x64 = Sun/Astrolabe, right 64x64 = Moon/Rose)
    gender_img = Image.new("RGBA", (128, 64), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(gender_img)
    for idx, (col_ring, col_core, label) in enumerate([
        (CYAN_SEAFOAM, GOLD_AUREATE, "SOL"),
        (PINK_BLOSSOM, LILAC_MIST, "LUN"),
    ]):
        ox = idx * 64
        gdraw.rectangle([ox + 1, 1, ox + 62, 62], fill=PLUM_DARK, outline=BRASS_ANTIQUE, width=2)
        gdraw.rectangle([ox + 4, 4, ox + 59, 59], outline=(*col_ring[:3], 180), width=1)
        gdraw.ellipse([ox + 14, 14, ox + 50, 50], fill=(44, 28, 64, 255), outline=col_ring, width=2)
        if idx == 0:
            # Sunburst / Compass emblem
            gdraw.polygon([(ox + 32, 18), (ox + 37, 27), (ox + 46, 32), (ox + 37, 37), (ox + 32, 46), (ox + 27, 37), (ox + 18, 32), (ox + 27, 27)], fill=col_core)
            gdraw.ellipse([ox + 27, 27, ox + 37, 37], fill=CYAN_SEAFOAM)
        else:
            # Blossom / Crescent emblem
            gdraw.ellipse([ox + 21, 21, ox + 43, 43], fill=PINK_BLOSSOM)
            gdraw.ellipse([ox + 27, 19, ox + 45, 39], fill=(44, 28, 64, 255))
            gdraw.ellipse([ox + 31, 27, ox + 39, 35], fill=GOLD_AUREATE)
    write_blp2("Interface/Glues/CharacterCreate/UI-CharacterCreate-Gender.blp", gender_img)

    # 4. UI-CharacterCreate-Factions.blp (128x64: Porcelain Court vs Nocturnum Covenant)
    write_blp2("Interface/Glues/CharacterCreate/UI-CharacterCreate-Factions.blp", gender_img)

    # 5. UI-CharacterCreate-Banners.blp (256x256)
    # Placed behind the two race columns at x=84 and x=178 inside the 256x256 sheet
    banners_img = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    bdraw = ImageDraw.Draw(banners_img)
    for cx_b, fill_c, trim_c in [
        (84, (36, 54, 78, 175), CYAN_SEAFOAM),
        (178, (64, 28, 68, 175), PINK_BLOSSOM),
    ]:
        bw = 34
        pts = [
            (cx_b - bw, 4),
            (cx_b + bw, 4),
            (cx_b + bw, 210),
            (cx_b, 246),
            (cx_b - bw, 210),
        ]
        bdraw.polygon(pts, fill=fill_c, outline=BRASS_ANTIQUE)
        bdraw.line([pts[0], pts[1], pts[2], pts[3], pts[4], pts[0]], fill=trim_c, width=2)
    write_blp2("Interface/Glues/CharacterCreate/UI-CharacterCreate-Banners.blp", banners_img)


def build_ui_chrome_and_buttons():
    """
    Generates high-craft Celandia porcelain, antique brass, and seafoam cyan UI chrome matching
    the exact UV coordinates in crates/benilla-app/src/glue/art.rs and survivors/menu.rs.
    """
    # 1. Glue-Panel-Button-{Up,Down,Disabled,Highlight}.blp & UI-Panel-Button-*.blp
    # CRITICAL UV: BUTTON_TC = [0.0, 0.578125, 0.0, 0.75] -> on a 256x64 texture,
    # the active button region is x in [0..148], y in [0..48]!
    def make_button_tex(state: str) -> Image.Image:
        img = Image.new("RGBA", (256, 64), (0, 0, 0, 0))
        W, H = 148, 48
        if state == "Highlight":
            # BUTTON_HI_TC = [0.0, 0.625, 0.0, 0.6875] -> [0..160, 0..44] additive glow
            HW, HH = 160, 44
            arr = np.zeros((64, 256, 4), dtype=np.uint8)
            yy, xx = np.mgrid[0:HH, 0:HW]
            nx = (xx - HW * 0.5) / (HW * 0.5)
            ny = (yy - HH * 0.5) / (HH * 0.5)
            g = np.clip(1.0 - np.sqrt(nx * nx * 0.8 + ny * ny * 1.1), 0.0, 1.0) ** 1.5
            arr[0:HH, 0:HW, 0] = (g * 110).astype(np.uint8)
            arr[0:HH, 0:HW, 1] = (g * 85).astype(np.uint8)
            arr[0:HH, 0:HW, 2] = (g * 105).astype(np.uint8)
            arr[0:HH, 0:HW, 3] = 255
            return Image.fromarray(arr, "RGBA")

        sub = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(sub)
        if state == "Up":
            top_c = (62, 38, 82)
            bot_c = (32, 19, 46)
            border_c = BRASS_ANTIQUE
            inner_c = (*PINK_BLOSSOM[:3], 150)
        elif state == "Down":
            top_c = (26, 16, 38)
            bot_c = (48, 30, 66)
            border_c = CYAN_SEAFOAM
            inner_c = (*GOLD_AUREATE[:3], 180)
        else:  # Disabled
            top_c = (38, 34, 44)
            bot_c = (24, 22, 28)
            border_c = (110, 102, 118, 220)
            inner_c = (80, 75, 88, 120)

        # Vertical gradient fill inside button pill
        arr = np.zeros((H, W, 4), dtype=np.uint8)
        for y in range(H):
            t = y / max(1, H - 1)
            # Subtle specular sheen along top quarter
            sheen = 18 if (state == "Up" and 3 <= y <= 12) else 0
            r = min(255, int(top_c[0] * (1 - t) + bot_c[0] * t) + sheen)
            g = min(255, int(top_c[1] * (1 - t) + bot_c[1] * t) + sheen)
            b = min(255, int(top_c[2] * (1 - t) + bot_c[2] * t) + sheen)
            arr[y, :, 0] = r
            arr[y, :, 1] = g
            arr[y, :, 2] = b
            arr[y, :, 3] = 248
        sub = Image.fromarray(arr, "RGBA")
        d = ImageDraw.Draw(sub)

        # Crisp outer dark ink rim + antique brass bevel + inner blossom hairline
        d.rounded_rectangle([0, 0, W - 1, H - 1], radius=8, outline=INK_DEEP, width=2)
        d.rounded_rectangle([2, 2, W - 3, H - 3], radius=6, outline=border_c, width=2)
        d.rounded_rectangle([4, 4, W - 5, H - 5], radius=4, outline=inner_c, width=1)

        # Brass corner rivets
        for rx, ry in [(7, 7), (W - 8, 7), (7, H - 8), (W - 8, H - 8)]:
            d.ellipse([rx - 2, ry - 2, rx + 2, ry + 2], fill=GOLD_AUREATE)

        img.paste(sub, (0, 0))
        return img

    for st in ("Up", "Down", "Disabled", "Highlight"):
        btex = make_button_tex(st)
        write_blp2(f"Interface/Glues/Common/Glue-Panel-Button-{st}.blp", btex)
        write_blp2(f"Interface/Buttons/UI-Panel-Button-{st}.blp", btex)
    write_blp2("Interface/Buttons/UI-Panel-Button-Highlight2.blp", make_button_tex("Highlight"))

    # 2. UI-CharacterCreate-Background.blp (256x256)
    # Composite of Celandia's 01-porcelain-wildwoods.png deeply tinted in twilight plum
    wildwoods = crop_aspect(load_art_image("01-porcelain-wildwoods.png"), 256, 256, 0.5)
    w_arr = np.array(wildwoods, dtype=np.float32)
    yy, xx = np.mgrid[0:256, 0:256]
    edge_vignette = np.clip(np.minimum(np.minimum(xx, 255 - xx), np.minimum(yy, 255 - yy)) / 28.0, 0.2, 1.0)
    # Blend 22% concept art texture into deep porcelain plum (#21152d)
    bg_arr = np.zeros((256, 256, 4), dtype=np.uint8)
    bg_arr[:, :, 0] = np.clip((28.0 + w_arr[:, :, 0] * 0.14) * edge_vignette, 14, 68).astype(np.uint8)
    bg_arr[:, :, 1] = np.clip((18.0 + w_arr[:, :, 1] * 0.12) * edge_vignette, 10, 48).astype(np.uint8)
    bg_arr[:, :, 2] = np.clip((42.0 + w_arr[:, :, 2] * 0.18) * edge_vignette, 22, 88).astype(np.uint8)
    bg_arr[:, :, 3] = 244
    write_blp2("Interface/Glues/CharacterCreate/UI-CharacterCreate-Background.blp", Image.fromarray(bg_arr, "RGBA"))

    # 3. UI-CharacterCreate-OuterBorder.blp (256x256)
    # CRITICAL UV: menu.rs and char_create/screen.rs crop [0.0, 0.875, ...] -> x in [0..224]!
    # So the right vertical rail MUST sit at x = 215..223 (NOT 248..255), and the center
    # x = 9..214 MUST be transparent (alpha = 0) so UI-CharacterCreate-Background shows through!
    ob = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    od = ImageDraw.Draw(ob)
    W_OB = 224
    # Left rail (x = 0..8) and Right rail (x = 215..223)
    for x0, x1 in [(0, 8), (W_OB - 9, W_OB - 1)]:
        od.rectangle([x0, 0, x1, 255], fill=(24, 15, 36, 255))
        od.line([(x0 + 1, 0), (x0 + 1, 255)], fill=BRASS_ANTIQUE, width=2)
        od.line([(x1 - 1, 0), (x1 - 1, 255)], fill=BRASS_ANTIQUE, width=2)
        od.line([((x0 + x1) // 2, 0), ((x0 + x1) // 2, 255)], fill=(*GOLD_AUREATE[:3], 180), width=1)
    # Top rail (y = 0..8) and Bottom rail (y = 247..255) across 0..223
    for y0, y1 in [(0, 8), (247, 255)]:
        od.rectangle([0, y0, W_OB - 1, y1], fill=(24, 15, 36, 255))
        od.line([(0, y0 + 2), (W_OB - 1, y0 + 2)], fill=BRASS_ANTIQUE, width=2)
        od.line([(0, y1 - 2), (W_OB - 1, y1 - 2)], fill=BRASS_ANTIQUE, width=2)
    # Corner rosettes at (4,4), (219,4), (4,251), (219,251)
    for cx_r, cy_r in [(4, 4), (W_OB - 5, 4), (4, 251), (W_OB - 5, 251)]:
        od.ellipse([cx_r - 4, cy_r - 4, cx_r + 4, cy_r + 4], fill=GOLD_AUREATE, outline=INK_DEEP)
    write_blp2("Interface/Glues/CharacterCreate/UI-CharacterCreate-OuterBorder.blp", ob)

    # 4. CharacterCreate-LabelFrame.blp (128x64, cropped to [0.0..1.0, 0.234..0.766] -> y=15..49)
    lf = Image.new("RGBA", (128, 64), (0, 0, 0, 0))
    lfd = ImageDraw.Draw(lf)
    lfd.rounded_rectangle([2, 15, 125, 48], radius=6, fill=(24, 15, 36, 238), outline=BRASS_ANTIQUE, width=2)
    lfd.rounded_rectangle([5, 18, 122, 45], radius=4, outline=(*CYAN_SEAFOAM[:3], 125), width=1)
    write_blp2("Interface/Glues/CharacterCreate/CharacterCreate-LabelFrame.blp", lf)

    # 5. ButtonHilight-Square.blp (64x64 ADD glow) & Glue-CharacterSelect-Highlight.blp (256x64 ADD)
    sq = np.zeros((64, 64, 4), dtype=np.uint8)
    for y in range(64):
        for x in range(64):
            d = min(x, 63 - x, y, 63 - y)
            if d < 10:
                v = (1.0 - d / 10.0) ** 1.3
                sq[y, x, 0] = int(255 * v)
                sq[y, x, 1] = int(215 * v)
                sq[y, x, 2] = int(145 * v)
            sq[y, x, 3] = 255
    write_blp2("Interface/Buttons/ButtonHilight-Square.blp", Image.fromarray(sq, "RGBA"))

    sel_hi = np.zeros((64, 256, 4), dtype=np.uint8)
    for y in range(64):
        vy = 1.0 - abs(y - 31.5) / 31.5
        bdr = 1.0 if (y < 4 or y > 59) else 0.35 * vy
        for x in range(256):
            vx = 1.0 - abs(x - 127.5) / 140.0
            g = max(0.0, min(1.0, bdr * max(0.2, vx)))
            sel_hi[y, x, 0] = int(195 * g)
            sel_hi[y, x, 1] = int(155 * g)
            sel_hi[y, x, 2] = int(95 * g)
            sel_hi[y, x, 3] = 255
    write_blp2("Interface/Glues/CharacterSelect/Glue-CharacterSelect-Highlight.blp", Image.fromarray(sel_hi, "RGBA"))


def build_loading_screens_and_arena_cards():
    """
    Generates:
    - Interface/Glues/LoadingScreens/LoadScreenCelandia.blp (512x512)
    - Interface/Glues/LoadingScreens/LoadScreenKalimdor.blp (512x512)
    - Interface/Glues/LoadingScreens/LoadScreenEasternKingdom.blp (512x512)
    - Interface/Celandia/Arena0.blp .. Arena3.blp (256x128 Kingdom Arena cards for Survivors menu)
    """
    archipelagos = load_art_image("04-four-archipelagos.png")
    wildwoods = load_art_image("01-porcelain-wildwoods.png")
    crossing = load_art_image("02-bubble-crossing.png")
    aureate = load_art_image("07-aureate-reach.png")
    serein_conv = load_art_image("10-serein-conversation.png")

    def make_load_screen(src: Image.Image, title: str, subtitle: str) -> Image.Image:
        img = crop_aspect(src, 512, 512, 0.45)
        draw = ImageDraw.Draw(img)
        # Ornate dark twilight header & footer bars + brass border
        draw.rectangle([0, 0, 511, 56], fill=(20, 12, 28, 225))
        draw.line([(0, 56), (511, 56)], fill=BRASS_ANTIQUE, width=3)
        draw.rectangle([0, 444, 511, 511], fill=(20, 12, 28, 232))
        draw.line([(0, 444), (511, 444)], fill=BRASS_ANTIQUE, width=3)
        draw.rectangle([4, 4, 507, 507], outline=BRASS_ANTIQUE, width=3)
        draw.rectangle([8, 8, 503, 503], outline=(*CYAN_SEAFOAM[:3], 150), width=1)

        f_top = load_font("display", 22)
        f_bot = load_font("bold", 15)
        b1 = draw.textbbox((0, 0), title, font=f_top)
        draw.text(((512 - (b1[2] - b1[0])) // 2, 16), title, font=f_top, fill=GOLD_AUREATE, stroke_width=2, stroke_fill=INK_DEEP)
        b2 = draw.textbbox((0, 0), subtitle, font=f_bot)
        draw.text(((512 - (b2[2] - b2[0])) // 2, 456), subtitle, font=f_bot, fill=PAPER_WARM, stroke_width=2, stroke_fill=INK_DEEP)
        return img

    ls_main = make_load_screen(archipelagos, "CELANDIA — THE ELSEWHERE TIDE", "Five Floating Kingdoms of the Porcelain Sea")
    ls_wild = make_load_screen(wildwoods, "THE PORCELAIN WAKE & WILDWOODS", "Pastel Canopies, Glass Bridges & Resonance Spires")
    ls_aur = make_load_screen(aureate, "THE AUREATE REACH & NOCTURNUM", "Gilded Sundials, Obsidian Reefs & Elsewhere Rifts")

    write_blp2("Interface/Glues/LoadingScreens/LoadScreenCelandia.blp", ls_main)
    write_blp2("Interface/Glues/LoadingScreens/LoadScreenKalimdor.blp", ls_wild)
    write_blp2("Interface/Glues/LoadingScreens/LoadScreenEasternKingdom.blp", ls_aur)

    # Kingdom Arena Preview Cards (256x128) for the Survivors Menu right tower!
    arena_sources = [
        ("Arena0", wildwoods, "THE PORCELAIN WAKE", PINK_BLOSSOM),
        ("Arena1", serein_conv, "FROSTBELL LAGOON", CYAN_SEAFOAM),
        ("Arena2", crossing, "GLASSWAKE MESAS", GOLD_AUREATE),
        ("Arena3", aureate, "AUREATE & NOCTURNUM", LILAC_MIST),
    ]
    for name, src, caption, accent in arena_sources:
        card = crop_aspect(src, 256, 128, 0.45)
        cd = ImageDraw.Draw(card)
        cd.rectangle([0, 98, 255, 127], fill=(20, 12, 28, 220))
        cd.line([(0, 98), (255, 98)], fill=BRASS_ANTIQUE, width=2)
        cd.rectangle([0, 0, 255, 127], outline=BRASS_ANTIQUE, width=2)
        cd.rectangle([3, 3, 252, 124], outline=(*accent[:3], 180), width=1)
        f_cap = load_font("bold", 12)
        bb = cd.textbbox((0, 0), caption, font=f_cap)
        cd.text(((256 - (bb[2] - bb[0])) // 2, 106), caption, font=f_cap, fill=accent, stroke_width=1, stroke_fill=INK_DEEP)
        write_blp2(f"Interface/Celandia/{name}.blp", card)


def build_spell_and_weapon_icons():
    """
    Renders rich 64x64 Celandia spell & weapon icons in Interface/Icons/*.blp combining
    generative art crops, glowing Celandia spell geometry, and ornate brass icon frames.
    """
    wildwoods = load_art_image("01-porcelain-wildwoods.png")
    crossing = load_art_image("02-bubble-crossing.png")
    archipelagos = load_art_image("04-four-archipelagos.png")
    aureate = load_art_image("07-aureate-reach.png")
    serein = load_art_image("10-serein-conversation.png")

    icon_defs = [
        # Exact SPELL_ICONS names referenced by SpellIcon.dbc & ItemDisplayInfo.dbc
        ("Ability_Porcelain_Slash", wildwoods, PINK_BLOSSOM, GOLD_AUREATE, "blade_arc"),
        ("Ability_Porcelain_Whirl", wildwoods, PINK_BLOSSOM, CYAN_SEAFOAM, "vortex_slash"),
        ("Ability_Porcelain_RoguishHook", crossing, GOLD_AUREATE, PINK_BLOSSOM, "spear_ray"),
        ("Spell_Frostbell_Chime", serein, CYAN_SEAFOAM, PAPER_WARM, "bell_nova"),
        ("Spell_Frostbell_Nova", serein, PAPER_WARM, CYAN_SEAFOAM, "shock_ring"),
        ("Spell_Frostbell_Squall", crossing, CYAN_SEAFOAM, LILAC_MIST, "comet"),
        ("Spell_Glasswake_Prism", crossing, CYAN_SEAFOAM, GOLD_AUREATE, "prism_beam"),
        ("Spell_Glasswake_Refract", crossing, PINK_BLOSSOM, CYAN_SEAFOAM, "compass_star"),
        ("Spell_Aureate_Sunburst", aureate, GOLD_AUREATE, PINK_BLOSSOM, "sunburst"),
        ("Spell_Aureate_Sanctuary", aureate, GOLD_AUREATE, PAPER_WARM, "aegis_shield"),
        ("Spell_Nocturnum_Lantern", archipelagos, LILAC_MIST, PINK_BLOSSOM, "hex_vortex"),
        ("Spell_Nocturnum_Eclipse", archipelagos, PINK_BLOSSOM, LILAC_MIST, "crescent"),
        ("Spell_Tekka_Voltekka", crossing, CYAN_SEAFOAM, GOLD_AUREATE, "lightning"),
        ("Spell_Jem_Starlight", serein, PINK_BLOSSOM, CYAN_SEAFOAM, "compass_star"),
        ("Ability_Sister_SoulRend", archipelagos, (255, 110, 140, 255), GOLD_AUREATE, "blade_arc"),
        # Additional aliases & weapon icons
        ("Ability_PorcelainWaltz", wildwoods, PINK_BLOSSOM, GOLD_AUREATE, "blade_arc"),
        ("Spell_FrostbellChime", serein, CYAN_SEAFOAM, PAPER_WARM, "bell_nova"),
        ("Spell_GlasswakeBeam", crossing, CYAN_SEAFOAM, GOLD_AUREATE, "prism_beam"),
        ("Spell_AureateFlare", aureate, GOLD_AUREATE, PINK_BLOSSOM, "sunburst"),
        ("Spell_NocturnumHex", archipelagos, LILAC_MIST, PINK_BLOSSOM, "hex_vortex"),
        ("Spell_ElsewhereComet", serein, CYAN_SEAFOAM, LILAC_MIST, "comet"),
        ("Spell_HushwoodSpores", wildwoods, (135, 225, 165, 255), GOLD_AUREATE, "spores"),
        ("Ability_Whirlwind", wildwoods, PINK_BLOSSOM, CYAN_SEAFOAM, "vortex_slash"),
        ("Ability_ThunderClap", crossing, CYAN_SEAFOAM, GOLD_AUREATE, "shock_ring"),
        ("Spell_SunlanceSpear", aureate, GOLD_AUREATE, PAPER_WARM, "spear_ray"),
        ("Spell_StormglassChain", crossing, CYAN_SEAFOAM, LILAC_MIST, "lightning"),
        ("Spell_VelvetTrap", archipelagos, PINK_BLOSSOM, LILAC_MIST, "snare_rose"),
        ("Spell_GildedAegis", aureate, GOLD_AUREATE, CYAN_SEAFOAM, "aegis_shield"),
        ("Spell_Chronocompass", aureate, GOLD_AUREATE, CYAN_SEAFOAM, "compass_star"),
        ("Spell_Moonlace", serein, LILAC_MIST, CYAN_SEAFOAM, "crescent"),
        ("Ability_Lunge", wildwoods, PINK_BLOSSOM, GOLD_AUREATE, "wing_dash"),
        ("Ability_GildedStep", aureate, GOLD_AUREATE, PAPER_WARM, "sunburst"),
        ("Ability_Tailwind", crossing, CYAN_SEAFOAM, PAPER_WARM, "wing_dash"),
        ("Ability_ShadowSlip", archipelagos, LILAC_MIST, PINK_BLOSSOM, "crescent"),
        ("Spell_ChorusVeil", serein, PAPER_WARM, GOLD_AUREATE, "bell_nova"),
        ("Spell_Tidepulse", crossing, CYAN_SEAFOAM, LILAC_MIST, "shock_ring"),
        ("Spell_PhaseShift", serein, CYAN_SEAFOAM, PINK_BLOSSOM, "compass_star"),
        ("Spell_DreadRift", archipelagos, LILAC_MIST, (255, 110, 160, 255), "hex_vortex"),
        ("Ability_BrambleSprint", wildwoods, (135, 225, 165, 255), GOLD_AUREATE, "wing_dash"),
        ("Weapon_PorcelainRapier", wildwoods, PINK_BLOSSOM, GOLD_AUREATE, "blade_arc"),
        ("Weapon_AureateSunblade", aureate, GOLD_AUREATE, PAPER_WARM, "spear_ray"),
        ("Weapon_GlasswakeBow", crossing, CYAN_SEAFOAM, GOLD_AUREATE, "prism_beam"),
        ("Weapon_NocturnumDagger", archipelagos, LILAC_MIST, PINK_BLOSSOM, "crescent"),
        ("Weapon_FrostbellStaff", serein, CYAN_SEAFOAM, PAPER_WARM, "bell_nova"),
        ("Weapon_StormglassTotem", crossing, CYAN_SEAFOAM, LILAC_MIST, "lightning"),
        ("Weapon_ElsewhereWand", serein, LILAC_MIST, CYAN_SEAFOAM, "comet"),
        ("INV_Misc_QuestionMark", aureate, GOLD_AUREATE, CYAN_SEAFOAM, "compass_star"),
    ]

    S = 128  # Render at 128x128 and downsample to 64x64
    for name, sheet, c1, c2, motif in icon_defs:
        bg = crop_aspect(sheet, S, S, 0.5).filter(ImageFilter.GaussianBlur(radius=2))
        arr = np.array(bg, dtype=np.float32)
        yy, xx = np.mgrid[0:S, 0:S]
        nx = (xx - 64.0) / 64.0
        ny = (yy - 64.0) / 64.0
        rad = np.sqrt(nx * nx + ny * ny)
        glow = np.clip(1.0 - rad * 0.85, 0.0, 1.0) ** 1.5
        for ch in range(3):
            arr[:, :, ch] = PLUM_DARK[ch] * 0.55 + arr[:, :, ch] * 0.25 + c1[ch] * glow * 0.45
        arr[:, :, 3] = 255.0
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")
        d = ImageDraw.Draw(img)

        cx, cy = 64, 64
        if motif == "blade_arc":
            d.arc([18, 18, 110, 110], start=200, end=350, fill=c1, width=10)
            d.line([(26, 102), (102, 26)], fill=PAPER_WARM, width=7)
            d.line([(26, 102), (102, 26)], fill=c2, width=3)
            d.polygon([(94, 20), (110, 18), (108, 34)], fill=PAPER_WARM)
        elif motif == "bell_nova":
            d.ellipse([24, 24, 104, 104], outline=c1, width=4)
            d.polygon([(64, 24), (88, 78), (40, 78)], fill=c1, outline=PAPER_WARM)
            d.ellipse([56, 76, 72, 92], fill=c2)
        elif motif == "prism_beam":
            d.line([(16, 112), (112, 16)], fill=c1, width=14)
            d.line([(16, 112), (112, 16)], fill=PAPER_WARM, width=6)
            d.polygon([(64, 26), (98, 64), (64, 102), (30, 64)], outline=c2, width=4)
        elif motif == "sunburst":
            for i in range(12):
                a = i * (math.pi / 6.0)
                r = 46 if i % 2 == 0 else 30
                d.line([(cx, cy), (cx + math.cos(a) * r, cy + math.sin(a) * r)], fill=c1, width=5)
            d.ellipse([44, 44, 84, 84], fill=PAPER_WARM, outline=c2, width=4)
        elif motif == "hex_vortex":
            for r, col in [(42, c1), (28, c2), (14, PAPER_WARM)]:
                pts = [(cx + math.cos(i * math.pi / 3) * r, cy + math.sin(i * math.pi / 3) * r) for i in range(6)]
                d.polygon(pts, outline=col, width=4)
        elif motif == "comet":
            d.line([(22, 22), (86, 86)], fill=c2, width=12)
            d.ellipse([64, 64, 106, 106], fill=PAPER_WARM, outline=c1, width=5)
        elif motif == "spores":
            for px_s, py_s, rr in [(42, 46, 14), (84, 42, 12), (64, 78, 16), (38, 84, 10), (88, 82, 11)]:
                d.ellipse([px_s - rr, py_s - rr, px_s + rr, py_s + rr], fill=c1, outline=PAPER_WARM, width=3)
        elif motif == "vortex_slash":
            d.arc([16, 16, 112, 112], start=0, end=270, fill=c1, width=9)
            d.arc([28, 28, 100, 100], start=90, end=360, fill=c2, width=7)
            d.ellipse([52, 52, 76, 76], fill=PAPER_WARM)
        elif motif == "shock_ring":
            d.ellipse([18, 18, 110, 110], outline=c1, width=6)
            d.ellipse([34, 34, 94, 94], outline=c2, width=5)
            d.ellipse([50, 50, 78, 78], fill=PAPER_WARM)
        elif motif == "spear_ray":
            d.line([(20, 108), (104, 24)], fill=c1, width=8)
            d.polygon([(108, 20), (76, 30), (98, 52)], fill=PAPER_WARM, outline=c2)
        elif motif == "lightning":
            pts = [(76, 16), (42, 64), (68, 64), (46, 112), (90, 56), (64, 56)]
            d.polygon(pts, fill=PAPER_WARM, outline=c1)
        elif motif == "snare_rose":
            for i in range(6):
                a = i * (math.pi / 3.0)
                d.ellipse([cx + math.cos(a) * 18 - 14, cy + math.sin(a) * 18 - 14, cx + math.cos(a) * 18 + 14, cy + math.sin(a) * 18 + 14], fill=c1, outline=PAPER_WARM, width=2)
            d.ellipse([52, 52, 76, 76], fill=c2)
        elif motif == "aegis_shield":
            pts = [(32, 24), (96, 24), (96, 68), (64, 108), (32, 68)]
            d.polygon(pts, fill=c1, outline=PAPER_WARM)
            d.polygon([(44, 36), (84, 36), (84, 64), (64, 92), (44, 64)], fill=PLUM_DARK, outline=c2)
        elif motif == "compass_star":
            d.polygon([(64, 16), (76, 52), (112, 64), (76, 76), (64, 112), (52, 76), (16, 64), (52, 52)], fill=c1, outline=PAPER_WARM)
            d.ellipse([52, 52, 76, 76], fill=c2)
        elif motif == "crescent":
            d.ellipse([24, 24, 104, 104], fill=c1, outline=PAPER_WARM, width=3)
            d.ellipse([42, 20, 110, 92], fill=PLUM_DARK)
        elif motif == "wing_dash":
            pts = [(20, 88), (64, 28), (108, 44), (76, 68), (104, 84), (52, 96)]
            d.polygon(pts, fill=c1, outline=PAPER_WARM)

        # Ornate Celandia brass-and-porcelain icon border
        d.rectangle([0, 0, S - 1, S - 1], outline=INK_DEEP, width=4)
        d.rectangle([4, 4, S - 5, S - 5], outline=BRASS_ANTIQUE, width=4)
        d.rectangle([9, 9, S - 10, S - 10], outline=(*c1[:3], 180), width=2)

        write_blp2(f"Interface/Icons/{name}.blp", img.resize((64, 64), Image.Resampling.LANCZOS))


def main():
    build_logo_textures()
    build_character_sheets()
    build_ui_chrome_and_buttons()
    build_loading_screens_and_arena_cards()
    build_spell_and_weapon_icons()
    print("[render-celandia-art] Rendered high-craft Celandia BLP2 textures from generative paintings & Geist/Bricolage fonts.")


if __name__ == "__main__":
    main()
