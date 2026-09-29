// data/nouns.bin (tools/build_dict.py が生成) を読み込む辞書。形式は build_dict.py 冒頭を参照。
// 辞書は元の綴り(小さい字入り)のまま持ち、照合時に小さい字と大きい字を同一視する。

const SM = "ぁぃぅぇぉっゃゅょゎゕゖ";
const LG = "あいうえおつやゆよわかけ";
const TO_CANON = new Map([...SM].map((s, i) => [s, LG[i]]));
/** 大きい字 -> 小さい字 (あ -> ぁ)。小さい字がある字だけ */
export const SMALL_OF = new Map([...LG].map((l, i) => [l, SM[i]]));
/** 小さい字を大きい字にそろえた文字列 (きっと -> きつと) */
export const canon = (s) => [...s].map((c) => TO_CANON.get(c) ?? c).join("");

export class Dict {
  constructor(buf) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x32445758) throw new Error("BAD DICTIONARY FORMAT"); // "XWD2"
    const count = dv.getUint32(4, true);
    const alen = dv.getUint16(8, true);
    this.chars = [];
    for (let i = 0; i < alen; i++) this.chars.push(String.fromCharCode(dv.getUint16(10 + i * 2, true)));
    const off = (10 + alen * 2 + 3) & ~3;
    this.nodes = new Uint32Array(buf, off, count);
  }

  static async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CANNOT LOAD DICTIONARY (${res.status})`);
    return new Dict(await res.arrayBuffer());
  }

  // トライ走査用。root は兄弟リストの先頭 index (1)。nodes[k] = v について:
  //   ch = chars[(v >>> 2) & 0x7f], end = v & 1, last = v & 2, level = (v >>> 9) & 15, child = v >>> 13 (0 なら子なし)
  static get ROOT() { return 1; }

  // 小さい字/大きい字を区別せずに単語の有無を調べる
  has(word) {
    return this.level(word) >= 0;
  }

  // 単語の難しさの段 (0=やさしい 〜 9)。辞書になければ -1。綴りが複数あれば一番やさしい段
  level(word) {
    const chars = [...canon(word)];
    if (!chars.length) return -1;
    const lv = this._min(1, 0, chars);
    return lv > 15 ? -1 : lv;
  }

  _min(p, i, chars) {
    const nodes = this.nodes;
    const want = chars[i];
    const alt = SMALL_OF.get(want);
    let best = 99;
    for (let k = p; ; k++) {
      const v = nodes[k];
      const ch = this.chars[(v >>> 2) & 0x7f];
      if (ch === want || ch === alt) {
        if (i === chars.length - 1) {
          if (v & 1) best = Math.min(best, (v >>> 9) & 15);
        } else {
          const child = v >>> 13;
          if (child) best = Math.min(best, this._min(child, i + 1, chars));
        }
      }
      if (v & 2) return best;
    }
  }
}
