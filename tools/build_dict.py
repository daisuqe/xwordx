"""_work/nouns_scored.tsv (tools/make_scored.py の出力) を軽量バイナリ data/nouns.bin に変換する。
各単語に「難しさの段(0=やさしい 〜 9=難しい)」を持たせる。

形式 (little endian):
  0  : "XWD2"                 マジック
  4  : uint32 nodeCount       ノード数 (index 0 は「子なし」用の番兵)
  8  : uint16 alphabetLen
  10 : uint16[alphabetLen]    文字表 (UTF-16 コードユニット)
  ...: 4バイト境界までパディング
  ...: uint32[nodeCount]      ノード配列

ノード (uint32):
  bit 0      end   : ここまでで単語が成立する
  bit 1      last  : 兄弟リストの最後
  bit 2-8    char  : 文字表の番号 (7bit)
  bit 9-12   level : end のときの難しさの段 (0-9)
  bit 13-31  child : 子の兄弟リスト先頭の index (0 = 子なし, 19bit)
兄弟リストは連続配置。共通接尾辞は (段も含めて) 共有される DAWG。ルートの兄弟リストは index 1 から。

段の決め方 (level 関数): 頻度の印(nf01-48)を主軸に、珍しい漢字(人名用・表外)を含む語は 1 段階難しくする。
印が無い語は、簡単な漢字だけで5文字以内なら 8、それ以外は 9。
"""
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "_work" / "nouns_scored.tsv"
DST = ROOT / "data" / "nouns.bin"

CHAR_BITS, LEVEL_BITS, CHILD_BITS = 7, 4, 19


def level(word, nf, pri, grade):
    if nf <= 48:
        lv = 0 if nf <= 4 else 1 if nf <= 8 else 2 if nf <= 12 else 3 if nf <= 16 else 4 if nf <= 24 else 5 if nf <= 36 else 6
        if grade >= 9:
            lv = min(lv + 1, 7)
        return lv
    if pri != "-":
        return 7
    return 8 if (grade <= 6 and len(word) <= 5) else 9


def load_words():
    words = {}
    for line in SRC.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        w, nf, pri, grade = line.split("\t")
        words[w] = level(w, int(nf), pri, int(grade))
    return words


def build(words):
    alphabet = sorted(set("".join(words)))
    index = {c: i for i, c in enumerate(alphabet)}
    assert len(alphabet) < (1 << CHAR_BITS)

    # トライを作り、同一部分木を共有 (DAWG化) しながら ID を割り当てる
    trie = {}
    for w in sorted(words):
        n = trie
        for c in w:
            n = n.setdefault(c, {})
        n[""] = words[w]  # 単語終端 (値は段)

    uniq = {}   # signature -> id
    nodes = []  # id -> tuple of (charIdx, end, level, childId or -1)

    def canon(n):
        edges = []
        for c in sorted(k for k in n if k):
            child = n[c]
            end = "" in child
            lv = child[""] if end else 0
            cid = canon(child) if any(k for k in child) else -1
            edges.append((index[c], end, lv, cid))
        sig = tuple(edges)
        if sig not in uniq:
            uniq[sig] = len(nodes)
            nodes.append(sig)
        return uniq[sig]

    root = canon(trie)

    # 兄弟リストを連続配置 (index 0 は番兵)
    start = {}
    pos = 1
    order = []
    stack = [root]
    seen = set()
    while stack:
        nid = stack.pop()
        if nid in seen:
            continue
        seen.add(nid)
        order.append(nid)
        for _, _, _, cid in reversed(nodes[nid]):
            if cid >= 0:
                stack.append(cid)
    for nid in order:
        start[nid] = pos
        pos += len(nodes[nid])

    arr = [0] * pos
    for nid in order:
        edges = nodes[nid]
        for k, (ci, end, lv, cid) in enumerate(edges):
            child = start[cid] if cid >= 0 else 0
            assert child < (1 << CHILD_BITS), "ノード数が多すぎます (CHILD_BITS を増やす)"
            assert lv < (1 << LEVEL_BITS)
            arr[start[nid] + k] = (child << 13) | (lv << 9) | (ci << 2) | ((k == len(edges) - 1) << 1) | int(end)
    assert start[root] == 1
    return alphabet, arr


def serialize(alphabet, arr):
    out = bytearray(b"XWD2")
    out += struct.pack("<IH", len(arr), len(alphabet))
    for c in alphabet:
        out += struct.pack("<H", ord(c))
    while len(out) % 4:
        out.append(0)
    out += struct.pack("<%dI" % len(arr), *arr)
    return bytes(out)


def lookup(alphabet, arr, word):
    """検証用 (JS 側 dict.js と同じアルゴリズム)。段を返す。なければ -1"""
    idx = {c: i for i, c in enumerate(alphabet)}
    p = 1
    v = 0
    for c in word:
        if c not in idx or p == 0:
            return -1
        ci = idx[c]
        while True:
            v = arr[p]
            if (v >> 2) & 0x7F == ci:
                break
            if v & 2:
                return -1
            p += 1
        p = v >> 13
    return (v >> 9) & 0xF if v & 1 else -1


def main():
    words = load_words()
    alphabet, arr = build(words)
    data = serialize(alphabet, arr)
    DST.parent.mkdir(exist_ok=True)
    DST.write_bytes(data)
    print(f"words={len(words)} nodes={len(arr)} bytes={len(data)}")

    # 全単語の往復確認 (段まで一致) + 非単語の確認
    for w, lv in words.items():
        assert lookup(alphabet, arr, w) == lv, w
    bad = 0
    for w in list(words)[::7]:
        for t in (w[:-1], w + "あ", w[1:]):
            if t and (t in words) != (lookup(alphabet, arr, t) >= 0):
                bad += 1
    assert bad == 0, bad
    counts = [0] * 10
    for lv in words.values():
        counts[lv] += 1
    print("level counts:", counts)
    print("verify ok")


if __name__ == "__main__":
    sys.exit(main())
