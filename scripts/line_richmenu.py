"""LINE のリッチメニュー（トークの下のボタン）を作る運用スクリプト。

遅れる 10分／30分／1時間以上／キャンセル の 4 つ。押すと postback が islands に届く
（core/line.py の handle_postback が受ける）。

使い方（何も送らない確認から）：
    python scripts/line_richmenu.py                       # 定義を表示し、画像を out/richmenu.png に作る
    python scripts/line_richmenu.py --image 自作.png      # 自分で作った 2500x843 の PNG を使う
    LINE_CHANNEL_ACCESS_TOKEN=... python scripts/line_richmenu.py --apply   # LINE に作って既定にする

--apply を付けたときだけ LINE に送る。画像を作るには Pillow が要る（本番のサーバーには入れない。
このスクリプトを動かす手元だけで `python -m pip install pillow`）。入れたくなければ --image で
自分の PNG を渡す。画像の決まり：PNG か JPEG、2500x843、1MB 以下、左から等しい幅（625px）で 4 つの枠。
"""

import argparse
import io
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core import line  # noqa: E402

FONT_CANDIDATES = (
    "C:/Windows/Fonts/YuGothB.ttc",
    "C:/Windows/Fonts/meiryob.ttc",
    "C:/Windows/Fonts/NotoSansJP-VF.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
)
BACKGROUND = "#EEF3F8"
BORDER = "#C9D6E2"
TEXT = "#1B2A3A"
TEXT_CANCEL = "#C0392B"
LABELS = (("10分くらい", "遅れる"), ("30分くらい", "遅れる"), ("1時間以上", "遅れる"), ("キャンセル", ""))


def make_image():
    """PNG のバイト列を返す。Pillow が無ければ RuntimeError。"""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as error:
        raise RuntimeError("画像を作るには Pillow が要ります（python -m pip install pillow）。"
                           "入れない場合は --image で自分の PNG を渡してください。") from error
    font_path = next((p for p in FONT_CANDIDATES if Path(p).exists()), None)
    if font_path is None:
        raise RuntimeError("日本語のフォントが見つかりません。--image で自分の PNG を渡してください。")
    width, height = line.RICH_MENU_SIZE
    cell = width // 4
    image = Image.new("RGB", (width, height), BACKGROUND)
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(font_path, 84)
    for index, (first, second) in enumerate(LABELS):
        left = index * cell
        draw.rectangle([left + 20, 20, left + cell - 20, height - 20], outline=BORDER, width=6)
        color = TEXT_CANCEL if index == 3 else TEXT
        rows = [row for row in (first, second) if row]
        total = len(rows) * 110
        top = (height - total) // 2
        for number, row in enumerate(rows):
            box = draw.textbbox((0, 0), row, font=font)
            x = left + (cell - (box[2] - box[0])) // 2
            draw.text((x, top + number * 110), row, font=font, fill=color)
    out = io.BytesIO()
    image.save(out, "PNG", optimize=True)
    data = out.getvalue()
    if len(data) > 1_000_000:
        raise RuntimeError("画像が 1MB を超えました。")
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--image", help="自分で作った PNG（2500x843）を使う")
    parser.add_argument("--out", default=str(ROOT / "out" / "richmenu.png"), help="作った画像の保存先")
    parser.add_argument("--apply", action="store_true", help="LINE に実際に作って、全員の既定にする")
    args = parser.parse_args(argv)

    print(json.dumps(line.rich_menu_payload(), ensure_ascii=False, indent=2))
    if args.image:
        image = Path(args.image).read_bytes()
    else:
        image = make_image()
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(image)
        print(f"画像を作りました：{out}")
    if not args.apply:
        print("（--apply が無いので、LINE には何も送っていません）")
        return 0
    if not line.configured():
        print("LINE_CHANNEL_SECRET と LINE_CHANNEL_ACCESS_TOKEN を環境変数に入れてください。", file=sys.stderr)
        return 1
    menu_id = line.setup_rich_menu(image)
    print(f"作りました。richMenuId = {menu_id}（全員の既定にしました）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
