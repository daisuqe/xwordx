import { Dict, canon, SMALL_OF } from "./dict.js";

const SIZE = 11;
const MIN_LEN = 2;
const ISLAND_DIV = 4; // 島の得点 = floor(面積^2 / ISLAND_DIV)
const COM_LEAD = 4; // COM が既存文字の何マス手前から単語を始めるか
const COM_MAX_LEN = 5; // COM が出す単語の最大文字数 (強さの調整用)
const COM_PICK = 5; // 上位いくつの候補からランダムに選ぶか
const COM_EASY_BONUS = 0.3; // 段が1つ易しいごとに COM の評価に足す点
const COM_NODE_BUDGET = 600000;
const COM_DELAY = 500;
const START_KANA = [..."あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわ"];
const DIRS = { right: [0, 1], down: [1, 0] };
const P = 1, C = 2; // 所有ビット: 1=あなた(青) 2=COM(赤) 3=両方(紫)
const NAME = { [P]: "YOU", [C]: "COM" };

const $ = (id) => document.getElementById(id);
const boardEl = $("board");
const wordEl = $("word");
const msgEl = $("message");
const turnEl = $("turn");
const logEl = $("log");

let dict = null;
// letters[r][c] = 大きい字にそろえたひらがな or "" / owner[r][c] = 所有ビット
// big[r][c] = 大きい字として使われた単語が通っている (小さい字がある字は、これが false の間は小さい字で表示)
let letters, owner, big;
let wordPts, used, turn, over, passes, lastMove;
const maxLv = { [P]: 9, [C]: 5 }; // それぞれが使える語の段の上限 (0=やさしい〜9)
let cellEls = [];

const toHira = (s) =>
  s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)).replace(/\s+/g, "");
const currentWord = () => toHira(wordEl.value);

// ---------- 盤面・得点 ----------

function newGame() {
  letters = Array.from({ length: SIZE }, () => Array(SIZE).fill(""));
  owner = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  big = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  const mid = (SIZE - 1) / 2;
  const kana = [...START_KANA].sort(() => Math.random() - 0.5);
  [[0, mid], [mid, 0], [SIZE - 1, mid], [mid, SIZE - 1]].forEach(([r, c], i) => {
    letters[r][c] = kana[i];
    big[r][c] = true;
  });
  wordPts = { [P]: 0, [C]: 0 };
  used = new Set();
  turn = P;
  over = false;
  passes = 0;
  lastMove = new Set();
  logEl.innerHTML = "";
  wordEl.value = "";
  render();
  say("YOUR TURN. TYPE A WORD, THEN DRAG FROM A START CELL TO THE RIGHT OR DOWN.");
}

// bit を持つマスの連結成分(島)の面積一覧
function islands(own, bit) {
  const seen = new Set();
  const sizes = [];
  for (let s = 0; s < SIZE * SIZE; s++) {
    if (seen.has(s) || !(own[(s / SIZE) | 0][s % SIZE] & bit)) continue;
    let n = 0;
    const st = [s];
    seen.add(s);
    while (st.length) {
      const k = st.pop();
      n++;
      const r = (k / SIZE) | 0, c = k % SIZE;
      for (const [rr, cc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
        if (rr < 0 || cc < 0 || rr >= SIZE || cc >= SIZE) continue;
        const j = rr * SIZE + cc;
        if (!seen.has(j) && own[rr][cc] & bit) { seen.add(j); st.push(j); }
      }
    }
    sizes.push(n);
  }
  return sizes;
}
const islandPts = (own, bit) => islands(own, bit).reduce((s, n) => s + Math.floor((n * n) / ISLAND_DIV), 0);
const total = (bit) => wordPts[bit] + islandPts(owner, bit);

// マスの表示文字。小さい字がある字は、大きい字の単語と共用されるまで小さい字で表示する
function shown(r, c) {
  const ch = letters[r][c];
  return !big[r][c] && SMALL_OF.get(ch) ? SMALL_OF.get(ch) : ch;
}

function render(preview) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const i = r * SIZE + c;
      const p = preview?.disp.get(i);
      const el = cellEls[i];
      el.textContent = letters[r][c] ? shown(r, c) : p || "";
      let cls = "cell";
      if (letters[r][c]) cls += " filled o" + owner[r][c];
      if (lastMove.has(i)) cls += " last";
      if (p) cls += preview.ok ? " pv-ok" : " pv-ng";
      el.className = cls;
    }
  }
  for (const bit of [P, C]) {
    $(bit === P ? "sp" : "sc").textContent = total(bit);
    const big = Math.max(0, ...islands(owner, bit));
    $(bit === P ? "dp" : "dc").textContent = `WORDS ${wordPts[bit]} + ISLANDS ${islandPts(owner, bit)} (BIGGEST ${big})`;
  }
  turnEl.textContent = over ? "GAME OVER" : turn === P ? "YOUR TURN" : "COM TURN";
  turnEl.className = over ? "over" : turn === P ? "p" : "c";
}

function say(text, bad = false) {
  msgEl.textContent = text;
  msgEl.classList.toggle("bad", bad);
}

function buildBoard() {
  boardEl.style.setProperty("--n", SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const el = document.createElement("div");
    el.className = "cell";
    boardEl.appendChild(el);
    cellEls.push(el);
  }
}

// ---------- ルール判定 ----------

// (r,c) を含む方向 [dr,dc] の連続文字列とそのマス index。tmp は仮置き (index -> 文字)
function runAt(r, c, [dr, dc], tmp) {
  const at = (rr, cc) => tmp.get(rr * SIZE + cc) ?? (letters[rr]?.[cc] || "");
  let r0 = r, c0 = c;
  while (r0 - dr >= 0 && c0 - dc >= 0 && at(r0 - dr, c0 - dc)) { r0 -= dr; c0 -= dc; }
  let s = "";
  const idx = [];
  for (let rr = r0, cc = c0; rr < SIZE && cc < SIZE && at(rr, cc); rr += dr, cc += dc) {
    s += at(rr, cc);
    idx.push(rr * SIZE + cc);
  }
  return { s, idx };
}

// 配置の検証。raw は入力された綴り(小さい字入り可)。小さい字と大きい字は同じ字として扱う。
// 成功: {ok:true, words(表示用), keys(重複判定用), points, cells(新規, 大きい字), disp(新規の表示字),
//        bigIdx(大きい字として使われたマス), touched(単語を構成する全マス)}
function check(raw, r, c, dir, limit = 9) {
  const [dr, dc] = DIRS[dir];
  const word = canon(raw);
  const rawChars = [...raw];
  const chars = [...word];
  const cells = new Map();
  const disp = new Map();
  const bigIdx = new Set();
  const fail = (error) => ({ ok: false, error, cells, disp });

  if (chars.length < MIN_LEN) return fail(`USE AT LEAST ${MIN_LEN} LETTERS`);
  let overlap = 0;
  const news = [];
  const touched = new Set();
  for (let i = 0; i < chars.length; i++) {
    const rr = r + dr * i, cc = c + dc * i;
    if (rr >= SIZE || cc >= SIZE) return fail("THE WORD GOES OFF THE BOARD");
    const cur = letters[rr][cc];
    if (cur && cur !== chars[i]) return fail(`DOES NOT MATCH THE LETTER "${shown(rr, cc)}"`);
    if (cur) overlap++;
    else { news.push([rr, cc]); cells.set(rr * SIZE + cc, chars[i]); disp.set(rr * SIZE + cc, rawChars[i]); }
    if (rawChars[i] === chars[i] && SMALL_OF.has(chars[i])) bigIdx.add(rr * SIZE + cc);
    touched.add(rr * SIZE + cc);
  }
  const er = r + dr * chars.length, ec = c + dc * chars.length;
  const before = r - dr >= 0 && c - dc >= 0 && letters[r - dr][c - dc];
  const after = er < SIZE && ec < SIZE && letters[er][ec];
  if (before || after) return fail("LETTERS TOUCH BOTH ENDS OF THE WORD");
  if (!news.length) return fail("PLACE AT LEAST ONE NEW LETTER");
  const level = dict.level(word);
  if (level < 0) return fail(`"${raw}" IS NOT IN THE DICTIONARY`);
  if (level > limit) return fail(`"${raw}" IS TOO HARD (LV ${limit} MAX)`);
  if (used.has(word)) return fail(`"${raw}" WAS ALREADY USED`);

  const words = [raw];
  const keys = [word];
  const perp = [dc, dr];
  for (const [rr, cc] of news) {
    const run = runAt(rr, cc, perp, cells);
    if (run.s.length > 1) {
      const text = run.idx.map((k) => disp.get(k) ?? shown((k / SIZE) | 0, k % SIZE)).join("");
      const lv = dict.level(run.s);
      if (lv < 0) return fail(`CROSS WORD "${text}" IS NOT IN THE DICTIONARY`);
      if (lv > limit) return fail(`CROSS WORD "${text}" IS TOO HARD`);
      words.push(text);
      keys.push(run.s);
      run.idx.forEach((k) => touched.add(k));
    }
  }
  if (!overlap && words.length === 1) return fail("MUST CONNECT TO EXISTING LETTERS");
  return { ok: true, words, keys, points: words.reduce((s, w) => s + [...w].length, 0), cells, disp, bigIdx, touched, level };
}

function apply(res, who) {
  res.cells.forEach((ch, k) => (letters[(k / SIZE) | 0][k % SIZE] = ch));
  res.bigIdx.forEach((k) => (big[(k / SIZE) | 0][k % SIZE] = true));
  res.touched.forEach((k) => (owner[(k / SIZE) | 0][k % SIZE] |= who));
  wordPts[who] += res.points;
  res.keys.forEach((w) => used.add(w));
  lastMove = new Set(res.touched);
  const li = document.createElement("li");
  li.className = who === P ? "p" : "c";
  li.textContent = `${NAME[who]}: ${res.words.join(" + ")}  +${res.points}  (Lv${res.level})`;
  logEl.prepend(li);
}

// ---------- ターン進行 ----------

function afterMove(who) {
  passes = who === "pass" ? passes : 0;
  const full = letters.every((row) => row.every(Boolean));
  if (full || passes >= 2) return finish();
  turn = turn === P ? C : P;
  render();
  if (turn === C) {
    say("COM IS THINKING...");
    setTimeout(comTurn, COM_DELAY);
  } else {
    say("YOUR TURN");
  }
}

function finish() {
  over = true;
  render();
  const a = total(P), b = total(C);
  say(a === b ? `DRAW ${a} - ${b}` : a > b ? `YOU WIN ${a} - ${b}` : `COM WINS ${a} - ${b}`);
}

function playerMove(word, r, c, dir) {
  const res = check(word, r, c, dir, maxLv[P]);
  if (!res.ok) return say(res.error, true);
  apply(res, P);
  wordEl.value = "";
  afterMove(P);
}

function pass(who) {
  passes++;
  const li = document.createElement("li");
  li.className = who === P ? "p" : "c";
  li.textContent = `${NAME[who]}: PASS`;
  logEl.prepend(li);
  lastMove = new Set();
  afterMove("pass");
}

// ---------- COM ----------

function comTurn() {
  const move = comSearch();
  if (!move) return pass(C);
  apply(move.res, C);
  say(`COM: ${move.res.words.join(" / ")} (+${move.res.points})`);
  afterMove(C);
}

function comSearch() {
  const nodes = dict.nodes, chars = dict.chars;
  const isAnchor = (r, c) => {
    if (letters[r][c]) return true;
    return (r > 0 && letters[r - 1][c]) || (r < SIZE - 1 && letters[r + 1][c]) || (c > 0 && letters[r][c - 1]) || (c < SIZE - 1 && letters[r][c + 1]);
  };
  const cands = [];
  let budget = COM_NODE_BUDGET;

  for (const dir of ["right", "down"]) {
    const [dr, dc] = DIRS[dir];
    const perp = [dc, dr];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (r - dr >= 0 && c - dc >= 0 && letters[r - dr][c - dc]) continue;
        // 最初に既存文字に触れるまでの距離
        let ai = -1;
        for (let i = 0; i <= COM_LEAD; i++) {
          const rr = r + dr * i, cc = c + dc * i;
          if (rr >= SIZE || cc >= SIZE) break;
          if (isAnchor(rr, cc)) { ai = i; break; }
        }
        if (ai < 0) continue;

        const dfs = (p, i, prefix) => {
          const rr = r + dr * i, cc = c + dc * i;
          const cur = letters[rr][cc];
          for (let k = p; ; k++) {
            const v = nodes[k];
            const ch = chars[(v >>> 2) & 0x7f]; // 辞書の綴り (小さい字のことがある)
            const cch = canon(ch); // 大きい字にそろえた字 (盤面と比べる用)
            if (--budget < 0) return;
            if (!cur || cur === cch) {
              let okCross = true;
              if (!cur) {
                const tmp = new Map([[rr * SIZE + cc, cch]]);
                const run = runAt(rr, cc, perp, tmp);
                if (run.s.length > 1 && !dict.has(run.s)) okCross = false;
              }
              if (okCross) {
                const word = prefix + ch;
                const er = rr + dr, ec = cc + dc;
                const inB = er < SIZE && ec < SIZE;
                if ((v & 1) && ((v >>> 9) & 15) <= maxLv[C] && i >= ai && i + 1 >= MIN_LEN && !(inB && letters[er][ec])) cands.push([word, r, c, dir]);
                const child = v >>> 13;
                if (child && inB && i + 1 < COM_MAX_LEN) dfs(child, i + 1, word);
              }
            }
            if (v & 2) break;
          }
        };
        dfs(1, 0, "");
      }
    }
  }

  const scored = [];
  const baseIsland = islandPts(owner, C);
  for (const [word, r, c, dir] of cands) {
    const res = check(word, r, c, dir, maxLv[C]);
    if (!res.ok) continue;
    const own = owner.map((row) => row.slice());
    res.touched.forEach((k) => (own[(k / SIZE) | 0][k % SIZE] |= C));
    // 相手の島を削る効果は無いので、自分の得点増加分で評価
    scored.push({ res, gain: res.points + islandPts(own, C) - baseIsland - res.level * COM_EASY_BONUS + Math.random() });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.gain - a.gain);
  const top = scored.slice(0, COM_PICK);
  return top[Math.floor(Math.random() * top.length)];
}

// ---------- 入力: 開始マスを押して、右か下へフリック ----------
let drag = null;

function cellAt(e) {
  const b = boardEl.getBoundingClientRect();
  const size = b.width / SIZE;
  const c = Math.floor((e.clientX - b.left) / size), r = Math.floor((e.clientY - b.top) / size);
  if (r < 0 || c < 0 || r >= SIZE || c >= SIZE) return null;
  return { r, c, size, cx: b.left + (c + 0.5) * size, cy: b.top + (r + 0.5) * size, dir: null };
}

function dragDir(e) {
  const dx = e.clientX - drag.cx, dy = e.clientY - drag.cy;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < drag.size * 0.6) return null;
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : null) : dy > 0 ? "down" : null;
}

boardEl.addEventListener("pointerdown", (e) => {
  if (!dict || over || turn !== P) return;
  const cell = cellAt(e);
  if (!cell) return;
  if (!currentWord()) return say("TYPE A WORD FIRST", true);
  boardEl.setPointerCapture(e.pointerId);
  drag = cell;
});

boardEl.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dir = dragDir(e);
  if (dir === drag.dir) return;
  drag.dir = dir;
  if (!dir) return render();
  const res = check(currentWord(), drag.r, drag.c, dir, maxLv[P]);
  render(res);
  say(res.ok ? `${res.words.join(" / ")} (+${res.points}, LV ${res.level}) RELEASE TO PLACE` : res.error, !res.ok);
});

boardEl.addEventListener("pointerup", (e) => {
  if (!drag) return;
  const { r, c } = drag;
  const dir = dragDir(e);
  drag = null;
  render();
  if (dir) playerMove(currentWord(), r, c, dir);
  else say("DRAG FROM THE START CELL TO THE RIGHT OR DOWN");
});
boardEl.addEventListener("pointercancel", () => { drag = null; render(); });

wordEl.addEventListener("change", () => (wordEl.value = currentWord()));
$("new").addEventListener("click", newGame);
$("lvC").value = String(maxLv[C]);
$("lvC").addEventListener("change", () => (maxLv[C] = Number($("lvC").value)));
$("pass").addEventListener("click", () => { if (dict && !over && turn === P) pass(P); });

buildBoard();
say("LOADING DICTIONARY...");
Dict.load("data/nouns.bin")
  .then((d) => { dict = d; newGame(); })
  .catch((err) => say(`${err.message} (OPEN VIA A WEB SERVER, NOT file://)`, true));
