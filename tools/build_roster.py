"""GRAVITYFOUR のキャラクター99人の名簿 (characters.js) から、xwordx 用の軽い roster.js を作る。

使い方: python tools/build_roster.py [GRAVITYFOUR のフォルダ]
  - 顔の画像 (16x16 のドット絵) は characters/ に、目と口のパーツは characters/parts/ にコピーする
  - roster.js には、名前・画像・強さ・声の種類など、この
    ゲームで使うものだけを入れる (走査線用のマスクは使わないので捨てる)
  - player-data.js には、キャラクターエディットの部品 (髪型・目・口の種類、色、髪/肌/服のマスク) を入れる。
    目と口の画像は、エディットで選べる分をすべて characters/parts/ にコピーする
"""
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"E:\User\Daisuke\Unity\GRAVITYFOUR")


def main():
    text = (SRC / "characters.js").read_text(encoding="utf-8")
    roster = json.loads(text[text.index("["):text.rindex("]") + 1])
    out = []
    (ROOT / "characters" / "parts").mkdir(parents=True, exist_ok=True)
    for c in roster:
        p = c["profile"]
        out.append({
            "name": c["name"], "file": c["file"], "eyes": c["eyes"], "mouth": c["mouth"],
            "strength": p["strength"], "rank": p["rank"], "voice": p["voice"], "gender": p["gender"],
            "personality": p["personality"], "tearful": bool(p.get("tearful")),
        })
        for part in (c["eyes"], c["mouth"]):
            shutil.copyfile(SRC / "characters" / "player-parts" / f"{part}.png", ROOT / "characters" / "parts" / f"{part}.png")
        shutil.copyfile(SRC / "characters" / c["file"], ROOT / "characters" / c["file"])
    # 勝ち・負けの表情 (目と口の代わりに重ねる) と涙
    for name in ("win.png", "lose.png", "tear.png"):
        shutil.copyfile(SRC / "characters" / name, ROOT / "characters" / name)
    body = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    (ROOT / "roster.js").write_text(f"// tools/build_roster.py が GRAVITYFOUR の名簿から作る (キャラクター99人)\nwindow.XwRoster = {body};\n", encoding="utf-8")
    print(f"{len(out)} characters -> roster.js ({len(body)} bytes)")

    # キャラクターエディット用のデータ (プレイヤーの顔は、髪・肌・服のマスクに色を塗り、目と口の画像を重ねて作る)
    ptext = (SRC / "player.js").read_text(encoding="utf-8")
    pd = json.loads(ptext[ptext.index("{"):ptext.rindex("}") + 1])
    keep = {k: pd[k] for k in ("defaults", "options", "palettes", "layerMasks")}
    pbody = json.dumps(keep, ensure_ascii=False, separators=(",", ":"))
    header = "// tools/build_roster.py が GRAVITYFOUR の player.js から作る (キャラクターエディットの部品)"
    (ROOT / "player-data.js").write_text(header + chr(10) + "window.XwPlayer = " + pbody + ";" + chr(10), encoding="utf-8")
    for png in (SRC / "characters" / "player-parts").glob("*.png"):
        shutil.copyfile(png, ROOT / "characters" / "parts" / png.name)
    print(f"player data -> player-data.js ({len(pbody)} bytes), parts: {len(list((ROOT / 'characters' / 'parts').glob('*.png')))}")


if __name__ == "__main__":
    main()
