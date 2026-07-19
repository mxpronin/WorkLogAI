from pathlib import Path
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "worklog-ai-launcher-source.png"
RESOURCES = ROOT / "android" / "app" / "src" / "main" / "res"

DENSITIES = {
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}


def resized(image, size):
    return image.resize((size, size), Image.Resampling.LANCZOS)


def round_icon(image, size):
    icon = resized(image, size).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    icon.putalpha(mask)
    return icon


def main():
    source = Image.open(SOURCE).convert("RGBA")
    if source.width != source.height:
        raise ValueError("Launcher icon source must be square")
    for density, (legacy_size, foreground_size) in DENSITIES.items():
        directory = RESOURCES / f"mipmap-{density}"
        directory.mkdir(parents=True, exist_ok=True)
        resized(source, legacy_size).save(directory / "ic_launcher.png", optimize=True)
        round_icon(source, legacy_size).save(directory / "ic_launcher_round.png", optimize=True)
        resized(source, foreground_size).save(directory / "ic_launcher_foreground.png", optimize=True)


if __name__ == "__main__":
    main()
