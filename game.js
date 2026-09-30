import { Dict, canon, SMALL_OF } from "./dict.js";

let SIZE = 11; // 盤面の大きさ。レベルごとに変わる (PROFILES.size)
const MIN_LEN = 2;
const ISLAND_STEP = 10; // 島の得点: 島が ISLAND_STEP マス増えるごとに ISLAND_BONUS 点
const ISLAND_BONUS = 10;
const CROSSING_BONUS = 5; // 新しくできた交点 (縦の単語と横の単語の両方に入るマス) 1つにつきの得点。誰の文字かは関係なく、その手を打った側に入る
const COM_LEAD = 2; // COM が既存文字の何マス手前から単語を始めるか
const COM_START_BUDGET = 6000; // 探索の開始位置ごとのノード数の上限
const COM_MAX_EVAL = 2500; // 評価する候補の上限 (多いときは無作為に間引く)
const COM_DELAY = 400;
const POP_STEP = 380; // 得点演出: 1行ごとの間隔 (ms)
const POP_HOLD = 1000; // 合計を出してから消えるまで (ms)
const START_KANA = [..."あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわ"];
const DIRS = { right: [0, 1], down: [1, 0] };
const P = 1, C = 2; // 所有ビット: 1=あなた(青) 2=COM(赤) 3=両方(紫)
const NAME = { [P]: "YOU", [C]: "COM" };

// COM のレベル別の性格
//   size      : 盤面の大きさ (size × size)
//   lv        : 使える語の段の上限 (0=やさしい〜9)
//   maxLen    : 出す単語の最大文字数
//   crossOnly : 既存の文字を通る(交差する)置き方しかしない。隣に並べてできる単語は使わない
//   random    : true なら得点も島も見ずに候補からランダムに選ぶ
//   island    : 島の得点を評価に入れる重み
//   crossBonus: 交差する置き方を好む度合い
//   noise     : 評価に足すランダム幅 (大きいほど雑)
//   pick      : 評価の上位いくつからランダムに選ぶか
const PROFILES = {
  easy: { name: "EASY", size: 9, lv: 1, maxLen: 5, crossOnly: true, random: true, pick: 1 },
  normal: { name: "NORMAL", size: 11, lv: 3, maxLen: 6, crossOnly: false, island: 0.3, crossBonus: 2, noise: 3, pick: 20 },
  hard: { name: "HARD", size: 11, lv: 6, maxLen: 7, crossOnly: false, island: 1, crossBonus: 0, noise: 1, pick: 15 },
  any: { name: "ANY", size: 11, lv: 9, maxLen: 8, crossOnly: false, island: 1.2, crossBonus: 0, noise: 0.5, pick: 8 },
};
const EASY_BONUS = 0.3; // 段が1つ易しいごとに評価に足す点

const $ = (id) => document.getElementById(id);
const boardEl = $("board");
const wordEl = $("word");
const msgEl = $("message");
const scoreCards = { [P]: document.querySelector(".sc.p"), [C]: document.querySelector(".sc.c") };
const logEl = $("log");

let dict = null;
// letters[r][c] = 大きい字にそろえたひらがな or "" / owner[r][c] = 所有ビット
// big[r][c] = 大きい字として使われた単語が通っている (小さい字がある字は、これが false の間は小さい字で表示)
let letters, owner, big;
let wordPts, crossPts, used, turn, over, passes, busy;
let marks = { [P]: [], [C]: [] }; // 各側の直近の手で新しくできた単語 (マス index の配列の配列)。相手の1ターンが終わるまでカプセルで囲む
let profile = PROFILES.normal;
let session = 0; // 新しい対局ごとに増やす。古い対局の COM の手番や演出を無効にする
let cellEls = [];

// ---------- 画面 ----------

// 入力欄にカーソルを置く (キーボードが出て盤面を隠すタッチ端末では自動では置かない)
function focusWord() {
  if (matchMedia("(hover: hover)").matches) wordEl.focus({ preventScroll: true });
}

function showView(name) {
  for (const v of ["title", "help", "game"]) $(`${v}-view`).hidden = v !== name;
  document.body.classList.toggle("in-game", name === "game"); // 対局中は 1 画面に収める (スクロールしない)
  if (name !== "game") window.scrollTo(0, 0);
}

// 盤面の枠の大きさ: できるだけ画面の幅いっぱいにする。高さが足りないときは、まずキーパッドのキーの高さを縮め、
// それでも足りない分だけ盤面を狭くする (画面からはみ出さない。幅いっぱいで収まるときは、下に余白が空く)
const KEY_H_MAX = 50, KEY_H_MIN = 30;
function fitBoard() {
  const view = $("game-view");
  if (view.hidden) return;
  const frame = view.querySelector(".board-frame");
  const pad = $("kana-pad");
  const gap = parseFloat(getComputedStyle(view).rowGap) || 0;
  let others = 0, count = 0, hasPad = false;
  for (const el of view.children) {
    if (el === frame || el.hidden) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.position === "fixed" || cs.position === "absolute") continue;
    if (el === pad) { hasPad = true; count++; continue; } // キーパッドの高さは下で計算する
    others += el.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    count++;
  }
  const avail = view.clientHeight - others - gap * count; // 盤面とキーパッドに使える高さ
  let room = avail;
  if (hasPad) {
    // キーパッドの高さ = キー4段 + 段の間 (6px x 3)
    const padGap = 18;
    const kh = Math.max(KEY_H_MIN, Math.min(KEY_H_MAX, (avail - view.clientWidth - padGap) / 4));
    view.style.setProperty("--kh", `${kh}px`);
    room = avail - (4 * kh + padGap);
  }
  const size = Math.max(120, Math.floor(Math.min(view.clientWidth, room)));
  frame.style.width = frame.style.height = `${size}px`;
}
new ResizeObserver(fitBoard).observe($("game-view"));
addEventListener("resize", fitBoard);
document.fonts?.ready.then(fitBoard);

function startGame(key) {
  profile = PROFILES[key];
  SIZE = profile.size;
  buildBoard();
  $("com-level").textContent = profile.name; // COM の枠のラベルにレベル名を出す
  showView("game");
  fitBoard();
  requestAnimationFrame(fitBoard); // フォントの読み込み後など、高さが変わったときのため
  newGame();
}

const toHira = (s) =>
  s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)).replace(/\s+/g, "");
const currentWord = () => toHira(wordEl.value);

function say(text, bad = false) {
  msgEl.textContent = text;
  msgEl.classList.toggle("bad", bad);
}

// ---------- 盤面・得点 ----------

function newGame() {
  session++;
  hidePop();
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
  crossPts = { [P]: 0, [C]: 0 };
  used = new Set();
  turn = P;
  over = false;
  busy = false;
  passes = 0;
  marks = { [P]: [], [C]: [] };
  logEl.innerHTML = "";
  wordEl.value = "";
  render();
  say("");
  focusWord();
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
const islandPts = (own, bit) => islands(own, bit).reduce((s, n) => s + Math.floor(n / ISLAND_STEP) * ISLAND_BONUS, 0);
const total = (bit) => wordPts[bit] + crossPts[bit] + islandPts(owner, bit);

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
      if (p) cls += preview.ok ? " pv-ok" : " pv-ng";
      el.className = cls;
    }
  }
  for (const bit of [P, C]) {
    $(bit === P ? "sp" : "sc").textContent = total(bit);
    $(bit === P ? "dp" : "dc").textContent = [`WORD ${wordPts[bit]}`, `CROSS ${crossPts[bit]}`, `ISLAND ${islandPts(owner, bit)}`].join("\n");
  }
  renderMarks();
  $("pass").disabled = over || turn !== P;
  // 手番のスコア枠を明るく光らせる (終了したら両方消す)
  for (const bit of [P, C]) scoreCards[bit].classList.toggle("active", !over && turn === bit);
}

// 新しくできた単語を長丸 (カプセル) で囲む。盤面の上に重ねた #marks に、マスの位置から計算して描く
function renderMarks() {
  const layer = $("marks");
  layer.replaceChildren();
  for (const bit of [P, C]) {
    for (const run of marks[bit]) {
      const first = cellEls[run[0]], last = cellEls[run[run.length - 1]];
      if (!first || !last) continue;
      // 太さはマスの8割 (マスの各辺から1割ずつ内側)。長さは単語の両端から1割ずつ外へはみ出させる
      const cell = first.offsetWidth;
      const across = cell * 0.1, along = -cell * 0.1;
      const horizontal = run[1] - run[0] === 1;
      const ix = horizontal ? along : across, iy = horizontal ? across : along;
      const pill = document.createElement("div");
      pill.className = "pill";
      pill.style.left = `${first.offsetLeft + ix}px`;
      pill.style.top = `${first.offsetTop + iy}px`;
      pill.style.width = `${last.offsetLeft + last.offsetWidth - first.offsetLeft - ix * 2}px`;
      pill.style.height = `${last.offsetTop + last.offsetHeight - first.offsetTop - iy * 2}px`;
      layer.appendChild(pill);
    }
  }
}
new ResizeObserver(() => cellEls.length && renderMarks()).observe(boardEl);

function buildBoard() {
  boardEl.style.setProperty("--n", SIZE);
  boardEl.setAttribute("aria-label", `${SIZE} by ${SIZE} board`);
  boardEl.replaceChildren();
  cellEls = [];
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
//        bigIdx(大きい字として使われたマス), touched(単語を構成する全マス), level, overlap(既存の文字を通った数),
//        intersections(新しくできた交点の数), runs(新しくできた単語のマス index)}
function check(raw, r, c, dir, limit = 9) {
  const [dr, dc] = DIRS[dir];
  const word = canon(raw);
  const rawChars = [...raw];
  const chars = [...word];
  const cells = new Map();
  const disp = new Map();
  const bigIdx = new Set();
  const fail = (error) => ({ ok: false, error, cells, disp });

  if (chars.length < MIN_LEN) return fail(`${MIN_LEN}+ LETTERS`);
  let overlap = 0;
  const news = [];
  const touched = new Set();
  const mainCells = [];
  for (let i = 0; i < chars.length; i++) {
    const rr = r + dr * i, cc = c + dc * i;
    if (rr >= SIZE || cc >= SIZE) return fail("OFF BOARD");
    const cur = letters[rr][cc];
    if (cur && cur !== chars[i]) return fail(`MISMATCH "${shown(rr, cc)}"`);
    if (cur) overlap++;
    else { news.push([rr, cc]); cells.set(rr * SIZE + cc, chars[i]); disp.set(rr * SIZE + cc, rawChars[i]); }
    if (rawChars[i] === chars[i] && SMALL_OF.has(chars[i])) bigIdx.add(rr * SIZE + cc);
    touched.add(rr * SIZE + cc);
    mainCells.push(rr * SIZE + cc);
  }
  const er = r + dr * chars.length, ec = c + dc * chars.length;
  const before = r - dr >= 0 && c - dc >= 0 && letters[r - dr][c - dc];
  const after = er < SIZE && ec < SIZE && letters[er][ec];
  if (before || after) return fail("LETTER AT THE END");
  if (!news.length) return fail("NEEDS A NEW LETTER");
  const level = dict.level(word);
  if (level < 0) return fail(`NOT A WORD: ${raw}`);
  if (level > limit) return fail(`TOO HARD: ${raw}`);
  if (used.has(word)) return fail(`ALREADY USED: ${raw}`);

  const words = [raw];
  const keys = [word];
  const perp = [dc, dr];
  const runs = [mainCells];
  for (const [rr, cc] of news) {
    const run = runAt(rr, cc, perp, cells);
    if (run.s.length > 1) {
      // 表示用の綴り。単語の先頭は小さい字にならないので、大きい字にそろえる
      const text = run.idx.map((k, j) => (j === 0 ? letters[(k / SIZE) | 0][k % SIZE] || cells.get(k) : disp.get(k) ?? shown((k / SIZE) | 0, k % SIZE))).join("");
      const lv = dict.level(run.s);
      if (lv < 0) return fail(`CROSS NOT A WORD: ${text}`);
      if (lv > limit) return fail(`CROSS TOO HARD: ${text}`);
      words.push(text);
      keys.push(run.s);
      runs.push(run.idx);
      run.idx.forEach((k) => touched.add(k));
    }
  }
  if (!overlap && words.length === 1) return fail("NOT CONNECTED");

  // 新しくできた交点: いま縦の単語と横の単語の両方に入っていて、この手より前はそうでなかったマス
  // (単語が変わるのは、この手で新しくできた単語のマスだけなので、touched だけ調べればよい)
  const none = new Map();
  const both = (r, c, tmp) => runAt(r, c, [0, 1], tmp).idx.length >= 2 && runAt(r, c, [1, 0], tmp).idx.length >= 2;
  let intersections = 0;
  for (const k of touched) {
    const r = (k / SIZE) | 0, c = k % SIZE;
    if (both(r, c, cells) && !(letters[r][c] && both(r, c, none))) intersections++;
  }
  return { ok: true, words, keys, points: words.reduce((s, w) => s + [...w].length, 0), cells, disp, bigIdx, touched, level, overlap, intersections, runs };
}

// 手を盤面に反映し、得点の内訳を返す
function apply(res, who) {
  const islandBefore = islandPts(owner, who);
  res.cells.forEach((ch, k) => (letters[(k / SIZE) | 0][k % SIZE] = ch));
  res.bigIdx.forEach((k) => (big[(k / SIZE) | 0][k % SIZE] = true));
  res.touched.forEach((k) => (owner[(k / SIZE) | 0][k % SIZE] |= who));
  const crossing = res.intersections * CROSSING_BONUS;
  wordPts[who] += res.points;
  crossPts[who] += crossing;
  res.keys.forEach((w) => used.add(w));
  marks[who] = res.runs;
  const islandGain = islandPts(owner, who) - islandBefore;
  const gain = res.points + crossing + islandGain;

  const li = document.createElement("li");
  li.className = who === P ? "p" : "c";
  li.textContent = `${NAME[who]}  ${res.words.join(" + ")}  +${gain}`;
  logEl.prepend(li);

  const items = res.words.map((w, i) => ({ tag: i === 0 ? "WORD" : "TOUCH", text: w, pts: [...w].length }));
  if (crossing) items.push({ tag: "CROSSING", text: `x${res.intersections}`, pts: crossing });
  if (islandGain > 0) items.push({ tag: "ISLAND", text: "", pts: islandGain });
  return { who, items, total: gain };
}

// ---------- 得点の演出 (画面中央に大きく、内訳を順に表示) ----------

let popTimer = null;
let popDone = null;

function hidePop() {
  clearTimeout(popTimer);
  $("pop").hidden = true;
  const done = popDone;
  popDone = null;
  if (done) done();
}

function showPop(bd) {
  return new Promise((resolve) => {
    const pop = $("pop"), card = $("pop-card");
    clearTimeout(popTimer);
    card.innerHTML = "";
    pop.className = "pop " + (bd.who === P ? "p" : "c");
    pop.hidden = false;
    popDone = resolve;
    const add = (html, cls) => {
      const d = document.createElement("div");
      d.className = cls;
      d.innerHTML = html;
      card.appendChild(d);
    };
    const esc = (t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
    const steps = [
      ...bd.items.map((it) => () => add(`<span class="tag">${it.tag}</span><span class="jp">${esc(it.text)}</span><b>+${it.pts}</b>`, "pop-line")),
      () => add(`<span class="tag">${NAME[bd.who]}</span><b>+${bd.total}</b>`, "pop-total"),
    ];
    let i = 0;
    const next = () => {
      if (i < steps.length) {
        steps[i++]();
        popTimer = setTimeout(next, i === steps.length ? POP_HOLD : POP_STEP);
      } else hidePop();
    };
    next();
  });
}
$("pop").addEventListener("click", hidePop); // タップでスキップ

// ---------- ターン進行 ----------

function afterMove(who) {
  marks[turn === P ? C : P] = []; // 手番が終わった: 前の相手の手のカプセルを消す
  passes = who === "pass" ? passes : 0;
  const full = letters.every((row) => row.every(Boolean));
  if (full || passes >= 2) return finish(passes >= 2 ? "BOTH PASSED" : "BOARD FULL");
  turn = turn === P ? C : P;
  render();
  if (turn === C) {
    if (who !== "pass") say("");
    const id = session;
    setTimeout(() => id === session && comTurn(), COM_DELAY);
  } else {
    focusWord();
  }
}

function finish(reason) {
  over = true;
  render();
  const a = total(P), b = total(C);
  say(`${reason}. ${a === b ? "DRAW" : a > b ? "YOU WIN" : "COM WINS"} ${a} - ${b}`);
}

async function playerMove(word, r, c, dir) {
  const res = check(word, r, c, dir);
  if (!res.ok) return say(res.error, true);
  const id = session;
  const bd = apply(res, P);
  wordEl.value = "";
  say("");
  render();
  busy = true;
  await showPop(bd);
  if (id !== session) return;
  busy = false;
  afterMove(P);
}

function pass(who) {
  passes++;
  const li = document.createElement("li");
  li.className = who === P ? "p" : "c";
  li.textContent = `${NAME[who]}  PASS`;
  logEl.prepend(li);
  // 2人が続けてパスすると終了 (afterMove の中で終了なら結果の表示に置き換わる)
  say(who === P ? "PASSED. THE GAME ENDS IF COM PASSES TOO." : "COM PASSED. PASS TO END THE GAME.");
  afterMove("pass");
}

// ---------- COM ----------

async function comTurn() {
  const id = session;
  const move = comSearch();
  if (!move) return pass(C);
  const bd = apply(move.res, C);
  render();
  await showPop(bd);
  if (id !== session) return;
  afterMove(C);
}

function comSearch() {
  const nodes = dict.nodes, chars = dict.chars;
  const cchars = chars.map(canon); // 大きい字にそろえた字 (盤面と比べる用)
  const { lv, maxLen, crossOnly } = profile;
  const filled = (r, c) => !!letters[r][c];
  const isAnchor = (r, c) => {
    if (filled(r, c)) return true;
    if (crossOnly) return false; // 交差専用: 既存の文字を通らない置き方は探さない
    return (r > 0 && letters[r - 1][c]) || (r < SIZE - 1 && letters[r + 1][c]) || (c > 0 && letters[r][c - 1]) || (c < SIZE - 1 && letters[r][c + 1]);
  };
  const sideFilled = (r, c, [pr, pc]) =>
    (r - pr >= 0 && c - pc >= 0 && letters[r - pr][c - pc]) || (r + pr < SIZE && c + pc < SIZE && letters[r + pr][c + pc]);
  let cands = [];
  let budget = 0;

  // 探索の開始位置 [向き, 行, 列, 既存文字に触れるまでの距離] を集め、順番をランダムにする。
  // (端から順に調べて予算を使い切ると、残りの場所を調べられずにパスになってしまうため)
  const starts = [];
  for (const dir of ["right", "down"]) {
    const [dr, dc] = DIRS[dir];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (r - dr >= 0 && c - dc >= 0 && letters[r - dr][c - dc]) continue;
        // 最初に既存文字に触れるまでの距離
        let ai = -1;
        for (let i = 0; i <= Math.min(COM_LEAD, maxLen - 1); i++) {
          const rr = r + dr * i, cc = c + dc * i;
          if (rr >= SIZE || cc >= SIZE) break;
          if (isAnchor(rr, cc)) { ai = i; break; }
        }
        if (ai >= 0) starts.push([dir, r, c, ai]);
      }
    }
  }
  for (let i = starts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [starts[i], starts[j]] = [starts[j], starts[i]];
  }

  for (const [dir, r, c, ai] of starts) {
    const [dr, dc] = DIRS[dir];
    const perp = [dc, dr];
    budget = COM_START_BUDGET; // 開始位置ごとに探索量の上限を決める

    const dfs = (p, i, prefix) => {
      const rr = r + dr * i, cc = c + dc * i;
      const cur = letters[rr][cc];
      // 兄弟の並び (先頭 p〜末尾) を、ランダムな位置から一周する。上限で打ち切っても「あ」から始まる語に偏らないため
      let end = p;
      while (!(nodes[end] & 2)) end++;
      const count = end - p + 1;
      const offset = Math.floor(Math.random() * count);
      for (let t = 0; t < count; t++) {
        const v = nodes[p + ((t + offset) % count)];
        const ci = (v >>> 2) & 0x7f;
        const ch = chars[ci]; // 辞書の綴り (小さい字のことがある)
        const cch = cchars[ci];
        if (--budget < 0) return;
        if (!cur || cur === cch) {
          let okCross = true;
          if (!cur && sideFilled(rr, cc, perp)) {
            // 直交方向に隣の文字がある: そこにできる単語を確かめる
            const run = runAt(rr, cc, perp, new Map([[rr * SIZE + cc, cch]]));
            if (run.s.length > 1 && (crossOnly || !dict.has(run.s))) okCross = false;
          }
          if (okCross) {
            const word = prefix + ch;
            const er = rr + dr, ec = cc + dc;
            const inB = er < SIZE && ec < SIZE;
            if ((v & 1) && ((v >>> 9) & 15) <= lv && i >= ai && i + 1 >= MIN_LEN && !(inB && letters[er][ec])) cands.push([word, r, c, dir]);
            const child = v >>> 13;
            if (child && inB && i + 1 < maxLen) dfs(child, i + 1, word);
          }
        }
      }
    };
    dfs(1, 0, "");
  }

  if (cands.length > COM_MAX_EVAL) {
    // 多すぎるときは無作為に間引く (評価が重いため)
    for (let i = cands.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cands[i], cands[j]] = [cands[j], cands[i]];
    }
    cands = cands.slice(0, COM_MAX_EVAL);
  }
  const scored = [];
  const baseIsland = islandPts(owner, C);
  for (const [word, r, c, dir] of cands) {
    const res = check(word, r, c, dir, lv);
    if (!res.ok) continue;
    if (crossOnly && (res.overlap < 1 || res.words.length > 1)) continue;
    let gain;
    if (profile.random) gain = Math.random(); // 得点も島も見ない
    else {
      const own = owner.map((row) => row.slice());
      res.touched.forEach((k) => (own[(k / SIZE) | 0][k % SIZE] |= C));
      const island = islandPts(own, C) - baseIsland;
      gain = res.points + res.intersections * CROSSING_BONUS + island * profile.island + (res.overlap ? profile.crossBonus : 0) - res.level * EASY_BONUS + Math.random() * profile.noise;
    }
    scored.push({ res, gain });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.gain - a.gain);
  const top = scored.slice(0, profile.pick);
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
  if (!dict || over || busy || turn !== P) return;
  const cell = cellAt(e);
  if (!cell) return;
  if (!currentWord()) return say("TYPE A WORD", true);
  boardEl.setPointerCapture(e.pointerId);
  drag = cell;
});

boardEl.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dir = dragDir(e);
  if (dir === drag.dir) return;
  drag.dir = dir;
  if (!dir) return render();
  const res = check(currentWord(), drag.r, drag.c, dir);
  render(res);
  say(res.ok ? `+${res.points}` : res.error, !res.ok);
});

boardEl.addEventListener("pointerup", (e) => {
  if (!drag) return;
  const { r, c } = drag;
  const dir = dragDir(e);
  drag = null;
  render();
  if (dir) playerMove(currentWord(), r, c, dir);
  else say("DRAG RIGHT OR DOWN");
});
boardEl.addEventListener("pointercancel", () => { drag = null; render(); });

wordEl.addEventListener("change", () => (wordEl.value = currentWord()));

// ---------- スマホ用: 盤面の下に日本語のフリック入力を再現 ----------
// 各キー: [中央(タップ), 左, 上, 右, 下] の順 (iOS のフリック入力と同じ)
const FLICK_KEYS = [
  ["あ", "いうえお"], ["か", "きくけこ"], ["さ", "しすせそ"],
  ["た", "ちつてと"], ["な", "にぬねの"], ["は", "ひふへほ"],
  ["ま", "みむめも"], ["や", "-ゆ-よ"], ["ら", "りるれろ"],
];
const WA_KEY = ["わ", "をん--"]; // 中央 わ / 左 を / 上 ん / 右・下は割り当てなし ("-")。ー は専用キーがある
const CYCLES = ["あぁ", "いぃ", "うぅゔ", "えぇ", "おぉ", "かが", "きぎ", "くぐ", "けげ", "こご", "さざ", "しじ", "すず", "せぜ", "そぞ",
  "ただ", "ちぢ", "つっづ", "てで", "とど", "はばぱ", "ひびぴ", "ふぶぷ", "へべぺ", "ほぼぽ", "やゃ", "ゆゅ", "よょ", "わゎ"];
const MAX_INPUT = 12;

function padInsert(ch) {
  if ([...wordEl.value].length < MAX_INPUT) wordEl.value += ch;
}
function padTransform() { // 小 ゛ ゜: 直前の字を小さい字/濁音/半濁音に切り替える
  const chars = [...wordEl.value];
  const last = chars.pop();
  const cyc = CYCLES.find((c) => c.includes(last));
  if (!cyc) return;
  chars.push(cyc[(cyc.indexOf(last) + 1) % cyc.length]);
  wordEl.value = chars.join("");
}

function buildKeypad() {
  const pad = $("kana-pad");
  // キー1つの大きさ (--k) を、画面の幅から決める。左端と下端の余白 (フリックの候補を出す場所) もこの大きさで確保する
  const fit = () => pad.style.setProperty("--k", `${(pad.parentElement.clientWidth - 18) / 4.8}px`);
  fit();
  new ResizeObserver(fit).observe(pad.parentElement);
  const dirs = ["c", "l", "u", "r", "d"];
  const flickKey = (label, others) => {
    const list = [label, ...[...others]]; // [中央, 左, 上, 右, 下]。"-" は割り当てなし
    const btn = document.createElement("div");
    btn.className = "fkey";
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", label);
    btn.innerHTML = `<span class="main">${label}</span>` +
      list.map((ch, i) => (ch === "-" ? "" : `<i class="fg ${dirs[i]}">${ch}</i>`)).join("");
    let st = null;
    const dirOf = (e) => {
      const dx = e.clientX - st.cx, dy = e.clientY - st.cy;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < st.size * 0.35) return 0;
      return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 1 : 3) : dy < 0 ? 2 : 4;
    };
    const mark = (d) => btn.querySelectorAll(".fg").forEach((el) => el.classList.toggle("sel", el.classList.contains(dirs[d])));
    btn.addEventListener("pointerdown", (e) => {
      const b = btn.getBoundingClientRect();
      st = { cx: b.left + b.width / 2, cy: b.top + b.height / 2, size: b.width, d: 0 };
      btn.setPointerCapture(e.pointerId);
      btn.classList.add("down");
      mark(0);
    });
    btn.addEventListener("pointermove", (e) => {
      if (!st) return;
      st.d = dirOf(e);
      mark(st.d);
    });
    btn.addEventListener("pointerup", (e) => {
      if (!st) return;
      const ch = list[dirOf(e)];
      st = null;
      btn.classList.remove("down");
      if (ch !== "-") padInsert(ch);
    });
    btn.addEventListener("pointercancel", () => { st = null; btn.classList.remove("down"); });
    return btn;
  };
  const action = (text, cls, fn, label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "akey " + cls;
    b.textContent = text;
    if (label) b.setAttribute("aria-label", label);
    b.addEventListener("click", fn);
    return b;
  };
  for (const [label, others] of FLICK_KEYS) pad.append(flickKey(label, others));
  pad.append(action("小゛゜", "small", padTransform, "small kana or dakuten")); // 下段: 小゛゜ / わ / ー
  pad.append(flickKey(...WA_KEY));
  pad.append(action("ー", "long", () => padInsert("ー"), "long vowel mark"));
  pad.append(action("DEL", "del", () => { wordEl.value = [...wordEl.value].slice(0, -1).join(""); }, "delete"));
  pad.append(action("CLR", "clr", () => { wordEl.value = ""; }, "clear"));
}

// タッチ端末では、端末のキーボードの代わりに盤面の下のキーパッドで入力する (?keypad=1 で PC でも確認できる)
if (matchMedia("(hover: none) and (pointer: coarse)").matches || new URLSearchParams(location.search).has("keypad")) {
  document.body.classList.add("keypad");
  wordEl.inputMode = "none";
  buildKeypad();
}
// スコアをタップすると内訳 (WORD / CROSS / ISLAND) を開閉する
for (const card of document.querySelectorAll(".sc")) {
  const toggle = () => card.setAttribute("aria-expanded", card.classList.toggle("open"));
  card.addEventListener("click", toggle);
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
}
$("pass").addEventListener("click", () => { if (dict && !over && !busy && turn === P) pass(P); });

for (const btn of document.querySelectorAll(".level-choice")) {
  btn.addEventListener("click", () => dict && startGame(btn.dataset.level));
}
// HOW TO PLAY の言語 (日本語が初期値)。選択は覚えておく
let helpLang = "ja";
try { helpLang = localStorage.getItem("xwordx-help-lang") === "en" ? "en" : "ja"; } catch (e) { /* 保存できなくても動く */ }
function setHelpLang(lang) {
  helpLang = lang;
  $("help-ja").hidden = lang !== "ja";
  $("help-en").hidden = lang !== "en";
  $("help-lang").textContent = lang === "ja" ? "ENGLISH" : "JAPANESE";
  try { localStorage.setItem("xwordx-help-lang", lang); } catch (e) { /* 保存できなくても動く */ }
}
setHelpLang(helpLang);
$("help-lang").addEventListener("click", () => setHelpLang(helpLang === "ja" ? "en" : "ja"));
$("help-open").addEventListener("click", () => { showView("help"); window.scrollTo(0, 0); });
$("help-back").addEventListener("click", () => showView("title"));
// MENU: 対局中なら確認してからタイトルへ
$("menu-back").addEventListener("click", () => {
  if (!over && logEl.children.length) $("leave-confirm").hidden = false;
  else showView("title");
});
$("leave-yes").addEventListener("click", () => { $("leave-confirm").hidden = true; session++; hidePop(); showView("title"); });
$("leave-no").addEventListener("click", () => { $("leave-confirm").hidden = true; focusWord(); });

const loadEl = $("load-status");
Dict.load("data/nouns.bin")
  .then((d) => {
    dict = d;
    loadEl.textContent = ""; // 読み込み中の表示を消す (エラーのときだけ文字を出す)
    document.body.classList.add("ready");
  })
  .catch((err) => {
    loadEl.textContent = `${err.message} (OPEN VIA A WEB SERVER, NOT file://)`;
    loadEl.classList.add("bad");
  });

// 確認用 (?debug を付けたときだけ): 盤面を直接セットして check() の結果を確かめる
if (new URLSearchParams(location.search).has("debug")) {
  window.xwordxDebug = {
    // rows: [[行, 列, "あ"], ...] の配列で盤面の文字を置き直す (所有者なし)
    setLetters(list) {
      letters = Array.from({ length: SIZE }, () => Array(SIZE).fill(""));
      big = Array.from({ length: SIZE }, () => Array(SIZE).fill(false)); // 実際のゲームと同じ: 最初から置いた文字だけが大きい字
      for (const [r, c, ch] of list) { letters[r][c] = ch; big[r][c] = true; }
      used = new Set();
    },
    // 実際に手を打つ (あなたの手として反映) して、盤面の表示文字を返す
    play(raw, r, c, dir) {
      const res = check(raw, r, c, dir);
      if (!res.ok) return { ok: false, error: res.error };
      apply(res, P);
      render();
      return { ok: true, shown: letters.map((row, rr) => row.map((ch, cc) => (ch ? shown(rr, cc) : "・")).join("")) };
    },
    comSearch: () => { const m = comSearch(); return m && { words: m.res.words, points: m.res.points, level: m.res.level }; },
    check: (raw, r, c, dir) => {
      const res = check(raw, r, c, dir);
      return res.ok ? { ok: true, words: res.words, points: res.points, intersections: res.intersections, overlap: res.overlap, runs: res.runs } : { ok: false, error: res.error };
    },
  };
}
