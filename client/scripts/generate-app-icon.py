"""Generate the original LatexStudio app mark; publisher tool only (Python + Pillow).

No downloaded art, installed fonts, platform executables or user profiles are used.
The shipped PNG/ICO files are sufficient for ordinary application users.
"""
from pathlib import Path

from PIL import Image, ImageDraw

BLUE = "#00659F"
ORANGE = "#E69F00"
WHITE = "#FFFFFF"
SCALE = 4
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def draw_icon(size: int = 512) -> Image.Image:
    """An original geometric L on a white folded paper, framed by a blue squircle."""
    canvas = Image.new("RGBA", (512 * SCALE, 512 * SCALE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    def box(coordinates: tuple[int, ...]) -> tuple[int, ...]:
        return tuple(value * SCALE for value in coordinates)

    def polygon(points: tuple[tuple[int, int], ...], color: str) -> None:
        draw.polygon([(x * SCALE, y * SCALE) for x, y in points], fill=color)

    # A generous transparent margin keeps the Windows taskbar silhouette clean.
    draw.rounded_rectangle(box((24, 24, 488, 488)), radius=108 * SCALE, fill=BLUE)
    draw.rounded_rectangle(box((128, 84, 384, 428)), radius=28 * SCALE, fill=WHITE)
    # Cut the upper-right paper corner, then fold it inward in restrained orange.
    polygon(((324, 84), (384, 84), (384, 144)), BLUE)
    polygon(((324, 84), (324, 144), (384, 144)), ORANGE)
    # The L is constructed from geometry, not a font or another app's trademark.
    draw.rounded_rectangle(box((181, 164, 221, 346)), radius=8 * SCALE, fill=BLUE)
    draw.rounded_rectangle(box((181, 306, 323, 346)), radius=8 * SCALE, fill=BLUE)
    draw.rounded_rectangle(box((181, 374, 309, 386)), radius=6 * SCALE, fill=BLUE)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def generate(output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    icon = draw_icon()
    icon.save(output / "paperstudio.png", format="PNG", optimize=True)
    icon.resize((256, 256), Image.Resampling.LANCZOS).save(
        output / "paperstudio-256.png", format="PNG", optimize=True
    )
    icon.save(output / "paperstudio.ico", format="ICO", sizes=[(n, n) for n in ICO_SIZES])
    draw_icon(1024).save(output / "paperstudio.icns", format="ICNS")
    print("Generated original LatexStudio PNG 512/256, Windows ICO and macOS ICNS")


if __name__ == "__main__":
    generate(Path(__file__).resolve().parents[1] / "resources" / "icons")
