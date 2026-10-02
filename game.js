import { Dict, canon, SMALL_OF } from "./dict.js";
import { RankBook, todayString, NEAR } from "./rank.js";

let SIZE = 11; // 盤面の大きさ。レベルごとに変わる (PROFILES.size)
const MIN_LEN = 2;
const GEM_SIZE = 0.95; // 交点のひし形の大きさ (マスに対する、ひし形の対角線の長さ)
const ISLAND_STEP = 10; // 島の得点: 島が ISLAND_STEP マス増えるごとに ISLAND_BONUS 点
const ISLAND_BONUS = 10;
const CROSSING_BONUS = 5; // 新しくできた交点 (縦の単語と横の単語の両方に入るマス) 1つにつきの得点。誰の文字かは関係なく、その手を打った側に入る
const COM_LEAD = 2; // COM が既存文字の何マス手前から単語を始めるか
const COM_START_BUDGET = 6000; // 探索の開始位置ごとのノード数の上限
const COM_MAX_EVAL = 2500; // 評価する候補の上限 (多いときは無作為に間引く)
const FAST = new URLSearchParams(location.search).has("fast"); // 動作確認用: 待ち時間を無くす
const COM_THINK_MS = FAST ? 0 : 3000; // COM が手を打つまでにかける時間の下限 (ms)
const POP_STEP = 380; // 得点演出: 1行ごとの間隔 (ms)
const POP_HOLD = FAST ? 1000 : 2600; // 合計を出してから消えるまで (ms)
const POP_MIN_MS = FAST ? 0 : 3000; // 得点の結果を最低でも表示する時間 (ms)。この間はタップで飛ばせない
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
  easy: { name: "EASY", size: 7, lv: 1, maxLen: 5, crossOnly: true, random: true, pick: 1 },
  normal: { name: "NORMAL", size: 7, lv: 3, maxLen: 6, crossOnly: false, island: 0.3, crossBonus: 2, noise: 3, pick: 20 },
  hard: { name: "HARD", size: 9, lv: 6, maxLen: 7, crossOnly: false, island: 1, crossBonus: 0, noise: 1, pick: 15 },
  any: { name: "ANY", size: 9, lv: 9, maxLen: 8, crossOnly: false, island: 1.2, crossBonus: 0, noise: 0.5, pick: 8 },
};
const EASY_BONUS = 0.3; // 段が1つ易しいごとに評価に足す点

// ランクマッチの COM の性格: 相手のキャラクターの強さ (18〜95) から連続的に決める
// rank (相手の現在の順位): 1〜5 位は強さのまま、6 位以降は強さを抑え、6〜25 位は難しい語 (段 5 以上) を使わない
const TOP_RANKS = 5, MID_RANKS = 25, MID_MAX_LV = 4, LOWER_MAX_T = 0.5;
function profileFromStrength(strength, rank = 99) {
  let t = Math.min(1, Math.max(0, (strength - 15) / 80)); // 0 (弱い) 〜 1 (強い)
  if (rank > TOP_RANKS) t = Math.min(t, LOWER_MAX_T);
  let lv = Math.round(1 + t * 8);
  if (rank > TOP_RANKS && rank <= MID_RANKS) lv = Math.min(lv, MID_MAX_LV);
  return {
    name: "RANK MATCH", size: 7,
    lv, maxLen: Math.round(4 + t * 4),
    crossOnly: t < 0.2, random: t < 0.12,
    island: t * 1.2, crossBonus: (1 - t) * 2, noise: 3 - t * 2.5, pick: Math.max(1, Math.round(20 - t * 18)),
  };
}
// 通常のレベルで戦うキャラクターを、レベルに見合う強さの中から選ぶ
const LEVEL_STRENGTH = { easy: [0, 35], normal: [36, 55], hard: [56, 75], any: [76, 100] };

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
let gems = []; // 直近の手で新しくできた交点のマス。次の手が置かれるまで、ひし形をゆっくり回す
let marks = { [P]: [], [C]: [] }; // 各側の直近の手で新しくできた単語 (マス index の配列の配列)。相手の1ターンが終わるまでカプセルで囲む
let profile = PROFILES.normal;
let mode = "level"; // "level": 通常のレベル / "rank": ランクマッチ
let opponent = null; // COM のキャラクター (名簿の1人)
const roster = window.XwRoster || [];
const rankBook = roster.length ? new RankBook(roster) : null;
if (rankBook) rankBook.dailyUpdate(); // 1日の最初の起動なら、COM 同士の対戦で順位を入れ替える
let rankRecorded = false; // この対局のランク結果を反映済みか
let rankFirst = P; // ランクマッチの先攻 (順位の高い方)
let moveCount = 0; // この対局で置かれた手の数 (パスは数えない)

// ---------- あなたのキャラクター (キャラクターエディット) ----------
// 顔は 16x16 のドット絵。肌・髪・服の 3 枚のマスクに色を塗って重ね、その上に目と口の画像を載せる (GRAVITYFOUR と同じ作り)。
// 選んだ内容は、このブラウザの localStorage に保存する。
const PD = window.XwPlayer;
const PLAYER_KEY = "xwordx-player-v1";
function readAvatar() {
  const a = { ...(PD?.defaults || {}), name: "YOU" };
  if (!PD) return a;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PLAYER_KEY)) || {}; } catch (e) { /* 保存がなければ初期値 */ }
  Object.assign(a, saved);
  for (const key of ["hair", "eyes", "mouth"]) if (!PD.options[key].includes(a[key])) a[key] = PD.defaults[key];
  if (a.hair.endsWith("w") && a.mouth === "mouth8") a.mouth = PD.defaults.mouth; // 髪型によっては選べない口がある
  for (const key of ["hair", "cloth", "skin"]) if (!PD.palettes[key].includes(a[key + "Color"])) a[key + "Color"] = PD.defaults[key + "Color"];
  a.name = /^[A-Z]{1,4}$/.test(saved.name) ? saved.name : "YOU";
  return a;
}
const avatar = readAvatar();
NAME[P] = avatar.name;
const saveAvatar = () => { try { localStorage.setItem(PLAYER_KEY, JSON.stringify(avatar)); } catch (e) { /* 保存できなくても動く */ } };

// マスク (16x16 を 64 桁の16進数で表したもの) の立っているマスに、色を塗る
function paintMask(canvas, mask, color) {
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(16, 16);
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => parseInt(mask.slice(i * 2, i * 2 + 2), 16));
  const rgb = [1, 3, 5].map((s) => parseInt(color.slice(s, s + 2), 16));
  for (let px = 0; px < 256; px++) {
    if (!(bytes[px >> 3] & (128 >> (px & 7)))) continue;
    image.data.set([rgb[0], rgb[1], rgb[2], 255], px * 4);
  }
  ctx.putImageData(image, 0, 0);
}
function paintPlayerFace(el) {
  if (!PD) return;
  if (!el.firstChild) {
    el.innerHTML = ["skin", "hair", "cloth"].map((k) => `<canvas data-k="${k}" width="16" height="16"></canvas>`).join("") +
      '<img class="f-eyes" alt=""><img class="f-mouth" alt="">' + EXPR_HTML;
  }
  for (const k of ["skin", "hair", "cloth"]) {
    const mask = k === "hair" ? PD.layerMasks.hair[avatar.hair] : PD.layerMasks[k];
    paintMask(el.querySelector(`canvas[data-k="${k}"]`), mask, avatar[k + "Color"]);
  }
  el.querySelector(".f-eyes").src = `characters/parts/${avatar.eyes}.png`;
  el.querySelector(".f-mouth").src = `characters/parts/${avatar.mouth}.png`;
  setExpression(el, el.dataset.expr || "normal", true);
}
function repaintPlayer() {
  document.querySelectorAll(".face.player").forEach(paintPlayerFace);
  $("you-name").textContent = avatar.name;
  document.querySelectorAll(".player-name").forEach((el) => (el.textContent = avatar.name));
}
let session = 0; // 新しい対局ごとに増やす。古い対局の COM の手番や演出を無効にする
let cellEls = [];

// ---------- 画面 ----------

// 入力欄にカーソルを置く (キーボードが出て盤面を隠すタッチ端末では自動では置かない)
function focusWord() {
  if (matchMedia("(hover: hover)").matches) wordEl.focus({ preventScroll: true });
}

let currentView = "title";
function showView(name) {
  currentView = name;
  closeScoreDetails();
  for (const v of ["title", "help", "edit", "rank", "game"]) $(`${v}-view`).hidden = v !== name;
  document.body.classList.toggle("in-game", name === "game"); // 対局中は 1 画面に収める (スクロールしない)
  if (name !== "game") window.scrollTo(0, 0);
  if (name === "rank") { centerRank(); requestAnimationFrame(centerRank); setTimeout(centerRank, 250); }
}

// 画面の縦方向の割り当て。優先順位:
//   1. キーは、指で押しやすい高さ KEY_H_COMFORT を確保する (足りないときは、その分だけ盤面を狭くする)
//   2. 盤面は画面の幅いっぱい (正方形)。ただしスマホ (キーパッドがあるとき) は PHONE_BOARD 倍にして、その分をキーに回す
//   3. 余裕があるときは、まず部品の間隔を (2人のスコアの間隔 = GAP_MAX まで)、次にキーの高さを最大まで広げる
// キーパッド: キーは3列で、キーどうしのすき間は無し。キー部分が画面の中央に来るよう、左右にキー1つぶんずつ余白を取る
//   (フリックの候補が、キーと同じ大きさで、左端のキーの左と右端のキーの右にも出るため)。
//   幅はその分だけ使い切り、高さは余った分だけ伸ばす (縦横比は、幅:高さ = 1:1〜KEY_ASPECT:1)。
//   下段のキーの下に出る候補は、メッセージ欄に重なってよいが、画面の外には出さない。
const GAP_MIN = 4, GAP_MAX = 10; // 部品どうしの縦の間隔
const KEY_H_COMFORT = 44; // キーの高さの下限 (iOS の押しやすさの目安)
const KEY_ASPECT = 1.5; // キーの 幅 / 高さ の上限 (高さが足りないとき、これより横長にはしない)
const KEYPAD_COLS = 3; // キーの列の数
const PHONE_BOARD = 0.9; // スマホ (キーパッドがあるとき) の盤面の大きさ (画面の幅に対する割合)
function fitBoard() {
  const view = $("game-view");
  if (view.hidden) return;
  fitNames(); // スコア枠の高さは文字の大きさで変わるので、先に決める
  const frame = view.querySelector(".board-frame");
  const pad = $("kana-pad");
  let others = 0, gaps = 0, hasPad = false;
  for (const el of view.children) {
    if (el === frame || el.hidden) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.position === "fixed" || cs.position === "absolute") continue;
    gaps++; // 盤面以外の部品の数 = 部品どうしの間隔の数
    if (el === pad) { hasPad = true; continue; } // キーパッドの高さは下で決める
    others += el.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  }
  const width = view.clientWidth;
  const base = view.clientHeight - others; // 盤面・キーパッド・部品の間隔に使える高さ
  const msgH = $("message").getBoundingClientRect().height;
  const bottomPad = parseFloat(getComputedStyle(view.parentElement).paddingBottom) || 0; // 画面の下端の余白 (安全領域を含む)
  const fullK = width / (KEYPAD_COLS + 2); // キーの幅の最大 (すき間なし。左右の余白がキー1つぶんずつ)
  const keyHMax = fullK; // キーの高さの最大 (正方形まで)
  const target = hasPad ? width * PHONE_BOARD : width; // 盤面の大きさの目標
  // 下段のキーを下へフリックしたときの候補は、メッセージ欄の上に重なってよいが、画面の外には出さない
  const reserveOf = (kh, gap) => Math.max(0, kh - (gap + msgH + bottomPad));
  const padH = (kh, gap) => 4 * kh + reserveOf(kh, gap);
  const need = (gap, kh) => target + gaps * gap + (hasPad ? padH(kh, gap) : 0); // 盤面が目標の大きさのときに必要な高さ

  let gap = GAP_MIN, kh = Math.min(KEY_H_COMFORT, keyHMax);
  const spare = base - need(gap, kh); // 負なら、盤面を狭くするしかない
  if (spare > 0) {
    gap += Math.min(GAP_MAX - GAP_MIN, spare / gaps); // まず部品の間隔を広げる
    if (hasPad) { // 残りでキーを大きくする (入る最大の高さを二分探索)
      if (need(gap, keyHMax) <= base) kh = keyHMax;
      else {
        let lo = kh, hi = keyHMax;
        for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (need(gap, mid) <= base) lo = mid; else hi = mid; }
        kh = lo;
      }
    }
  }
  view.style.rowGap = `${gap}px`;
  if (hasPad) {
    view.style.setProperty("--kh", `${kh}px`);
    pad.style.setProperty("--k", `${Math.min(fullK, kh * KEY_ASPECT)}px`);
    pad.style.setProperty("--reserve", `${reserveOf(kh, gap)}px`);
  }
  const room = base - gaps * gap - (hasPad ? padH(kh, gap) : 0);
  const size = Math.max(120, Math.floor(Math.min(target, room)));
  frame.style.width = frame.style.height = `${size}px`;
  // 入力欄は、盤面と同じ幅にする (スマホは盤面が 9 割なので、入力欄も 9 割)
  const entry = view.querySelector(".entry");
  entry.style.width = `${size}px`;
  entry.style.alignSelf = "center";
}

// スコア枠の名前と点数は、どちらも (これまでの) 1.5 倍の大きさで出す (CSS)。枠に収まらなければ、
// 名前と点数を同じ比率で、収まるまで少しずつ小さくする (--ns: 1 が 1.5 倍のまま)。
// 2つの枠で大きさがばらばらにならないよう、2つのうち小さい方の比率にそろえる。
const NAME_SCALE_MIN = 0.3;
function fitNames() {
  if ($("game-view").hidden) return;
  const cards = [...document.querySelectorAll(".game-view .sc")];
  let common = 1;
  for (const card of cards) { // それぞれの枠が収まる比率を調べる
    const who = card.querySelector(".who");
    let s = 1;
    card.style.setProperty("--ns", 1);
    while ((who.scrollWidth > who.clientWidth + 0.5 || card.scrollWidth > card.clientWidth + 0.5) && s > NAME_SCALE_MIN) {
      s = Math.round((s - 0.02) * 100) / 100;
      card.style.setProperty("--ns", s);
    }
    common = Math.min(common, s);
  }
  for (const card of cards) card.style.setProperty("--ns", common);
}
new ResizeObserver(fitBoard).observe($("game-view"));
new ResizeObserver(fitBoard).observe(document.querySelector(".scores"));
addEventListener("resize", fitBoard);
document.fonts?.ready.then(fitBoard);

// キャラクターの顔 (16x16 のドット絵: 体 + 目 + 口を重ねる)
// 表情の画像 (勝ち・負け) と涙。ふだんは隠しておき、目と口の代わりに重ねる
const EXPR_HTML = '<img class="f-expr" alt="" hidden><img class="f-tear" alt="" hidden>';
const faceHTML = (c) => `<img class="f-body" alt="" src="characters/${c.file}"><img class="f-eyes" alt="" src="characters/parts/${c.eyes}.png"><img class="f-mouth" alt="" src="characters/parts/${c.mouth}.png">${EXPR_HTML}`;

// 顔 el の表情を切り替える。expr: "normal" | "win" | "lose"。負けたときは、泣き顔のキャラクター (tearful) だけ涙が出る
function setExpression(el, expr, tearful) {
  if (!el) return;
  el.dataset.expr = expr;
  const normal = expr === "normal";
  const eyes = el.querySelector(".f-eyes"), mouth = el.querySelector(".f-mouth");
  const face = el.querySelector(".f-expr"), tear = el.querySelector(".f-tear");
  if (!face || !tear) return;
  if (eyes) eyes.hidden = !normal;
  if (mouth) mouth.hidden = !normal;
  face.hidden = normal;
  if (!normal) face.src = `characters/${expr}.png`;
  tear.hidden = !(expr === "lose" && tearful);
  if (!tear.hidden) tear.src = "characters/tear.png";
}
// 対局の結果を、2人の顔に出す (勝った方は win、負けた方は lose、引き分けはふつうの顔)
function showResultFaces(a, b) {
  setExpression($("you-face"), a > b ? "win" : a < b ? "lose" : "normal", true);
  setExpression($("com-face"), a < b ? "win" : a > b ? "lose" : "normal", !!opponent?.tearful);
}

function setOpponent(c) {
  opponent = c || null;
  NAME[C] = c ? c.name : "COM";
  $("com-name").textContent = NAME[C];
  $("com-face").innerHTML = c ? faceHTML(c) : "";
  $("com-face").hidden = !c;
}

function beginGame(label) {
  SIZE = profile.size;
  buildBoard();
  $("com-level").textContent = label;
  setOpponent(opponent);
  navigate("game");
  fitBoard();
  requestAnimationFrame(fitBoard); // フォントの読み込み後など、高さが変わったときのため
  newGame();
}

function startLevel(key) {
  mode = "level";
  profile = PROFILES[key];
  const [lo, hi] = LEVEL_STRENGTH[key];
  const pool = roster.filter((c) => c.strength >= lo && c.strength <= hi);
  opponent = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  beginGame(profile.name);
}

function startRank(name, first) {
  mode = "rank";
  rankFirst = first; // 順位の高い方が先攻
  opponent = roster.find((c) => c.name === name);
  const oppRank = rankBook?.standings().find((r) => r.name === name)?.rank;
  profile = profileFromStrength(opponent.strength, oppRank);
  beginGame("RANK MATCH");
}

// ランクマッチの一覧: 1 位から全員 (一覧の中だけスクロール)。押すとその相手と対戦する
// 一覧を開いた直後は、自分の行を真ん中に出す。画面の大きさが決まる前に測らないよう、
// 表示されたあとや大きさが変わったときにも、利用者が触るまでは合わせ直す
let rankCentered = false;
function centerRank() {
  const list = $("rank-list"), row = list.querySelector(".me");
  if (!row || $("rank-view").hidden || rankCentered) return;
  const lr = list.getBoundingClientRect(), rr = row.getBoundingClientRect();
  list.scrollTop += rr.top - lr.top - (list.clientHeight - rr.height) / 2; // 実際の位置の差で測る
}
{
  const list = $("rank-list");
  new ResizeObserver(centerRank).observe(list);
  for (const t of ["pointerdown", "wheel", "touchstart"]) list.addEventListener(t, () => { rankCentered = true; }, { passive: true });
}
function renderRank() {
  if (!rankBook) return;
  const { me, rows } = rankBook.nearby(); // 1 位から最下位まで全員
  const st = rankBook.state.player;
  $("rank-summary").innerHTML = `<span>RANK ${me.rank} / ${roster.length + 1}   RATING ${Math.round(me.rating)}</span><span>WIN ${st.wins} / LOSE ${st.losses} / DRAW ${st.draws}</span>`;
  const daily = rankBook.state.daily;
  $("rank-daily").textContent = daily && daily.date === todayString() ? `TODAY: ${daily.matches} COM MATCHES PLAYED` : "";
  const list = $("rank-list");
  list.replaceChildren();
  for (const r of rows) {
    const li = document.createElement("li");
    const c = roster.find((x) => x.name === r.name);
    const arrow = r.change > 0 ? `<i class="up">▲${r.change}</i>` : r.change < 0 ? `<i class="down">▼${-r.change}</i>` : "<i></i>";
    const face = r.isPlayer ? '<span class="face player"></span>' : `<span class="face">${c ? faceHTML(c) : ""}</span>`;
    const body = `<span class="rk">${r.rank}</span>${face}<span class="nm">${r.isPlayer ? avatar.name : r.name}</span><span class="rt">${Math.round(r.rating)}</span>${arrow}`;
    if (r.isPlayer) li.className = "me";
    li.innerHTML = `<div class="rank-row">${body}</div>`;
    list.appendChild(li);
  }
  list.querySelectorAll(".face.player").forEach(paintPlayerFace);
  rankCentered = false;
  centerRank();
}

// 対局が終わったとき (ランクマッチなら) レーティングに反映する。結果の文を返す
function recordRank(a, b) {
  if (mode !== "rank" || !opponent || !rankBook || rankRecorded) return null;
  rankRecorded = true;
  return rankBook.record(opponent.name, a === b ? 0.5 : a > b ? 1 : 0); // { oldRank, newRank, delta, rating }
}
const rankText = (r) => (r ? `  順位 ${r.oldRank}→${r.newRank} (${r.delta >= 0 ? "+" : ""}${r.delta})` : "");

const toHira = (s) =>
  s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)).replace(/\s+/g, "");
const currentWord = () => toHira(wordEl.value);

// メッセージが1行に収まらないときは、5秒後にゆっくり横へスクロールする。
// 最後の文字が見えたら5秒止まり、そのあと先頭の文字から表示し直して、また5秒後に繰り返す。
const MSG_WAIT_MS = 5000; // スクロールを始めるまでの待ち / 最後まで見えたあとの停止
const MSG_SPEED = 38; // スクロールの速さ (px/秒)
const msgText = document.createElement("span");
msgText.className = "msg-text";
msgEl.append(msgText);
let msgAnim = null;
function scrollMessage() {
  msgAnim?.cancel();
  msgAnim = null;
  const over = msgText.getBoundingClientRect().width - msgEl.clientWidth; // はみ出している長さ
  if (over <= 1 || FAST) return;
  const move = (over / MSG_SPEED) * 1000;
  const cycle = MSG_WAIT_MS + move + MSG_WAIT_MS;
  msgAnim = msgText.animate(
    [
      { transform: "translateX(0)", offset: 0 },
      { transform: "translateX(0)", offset: MSG_WAIT_MS / cycle }, // 5秒待つ
      { transform: `translateX(${-over}px)`, offset: (MSG_WAIT_MS + move) / cycle }, // ゆっくり最後までスクロール
      { transform: `translateX(${-over}px)`, offset: 1 }, // 最後の文字が見えたまま5秒止まる (そのあと先頭に戻る)
    ],
    { duration: cycle, iterations: Infinity, easing: "linear" },
  );
}
function say(text, bad = false, good = false) {
  msgText.textContent = text;
  msgEl.classList.toggle("bad", bad);
  msgEl.classList.toggle("ok", good);
  scrollMessage();
}
new ResizeObserver(() => scrollMessage()).observe(msgEl); // 窓の大きさが変わったら、はみ出しを測り直す

// 入力中の単語が辞書にあるかを、リアルタイムでステータス (一番下のメッセージ) に出す
function updateWordStatus() {
  if (!dict || over || busy || turn !== P) return;
  const w = currentWord();
  if (!w) return say("");
  if ([...w].length < MIN_LEN) return say(`${MIN_LEN}文字以上にしてください: ${w}`);
  const lv = dict.level(w);
  if (lv < 0) return say(`辞書にありません: ${w}`, true);
  if (used.has(canon(w))) return say(`使用済みです: ${w}`, true);
  say(`辞書にあります: ${w}  (段 ${lv})`, false, true);
}

// ---------- 盤面・得点 ----------

function newGame() {
  session++;
  hidePop();
  hideVictory();
  rankRecorded = false;
  moveCount = 0;
  setExpression($("you-face"), "normal", true); // 顔をふつうの表情に戻す
  setExpression($("com-face"), "normal", false);
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
  turn = mode === "rank" && rankFirst === C ? C : P; // ランクマッチは順位の高い方が先攻
  over = false;
  busy = false;
  passes = 0;
  marks = { [P]: [], [C]: [] };
  gems = [];
  logEl.innerHTML = "";
  wordEl.value = "";
  render();
  say(mode === "rank" ? (turn === C ? `${NAME[C]}の先攻です` : "あなたの先攻です") : "");
  if (turn === C) {
    const id = session;
    setTimeout(() => id === session && comTurn(), 0);
  } else focusWord();
}

// bit を持つマスの連結成分 (島)。島ごとのマス index の配列の一覧
function islandGroups(own, bit) {
  const seen = new Set();
  const groups = [];
  for (let s = 0; s < SIZE * SIZE; s++) {
    if (seen.has(s) || !(own[(s / SIZE) | 0][s % SIZE] & bit)) continue;
    const cells = [];
    const st = [s];
    seen.add(s);
    while (st.length) {
      const k = st.pop();
      cells.push(k);
      const r = (k / SIZE) | 0, c = k % SIZE;
      for (const [rr, cc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
        if (rr < 0 || cc < 0 || rr >= SIZE || cc >= SIZE) continue;
        const j = rr * SIZE + cc;
        if (!seen.has(j) && own[rr][cc] & bit) { seen.add(j); st.push(j); }
      }
    }
    groups.push(cells);
  }
  return groups;
}
const islands = (own, bit) => islandGroups(own, bit).map((cells) => cells.length); // 島の面積一覧
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
    $(bit === P ? "sp" : "sc").textContent = scoreHold ? scoreHold[bit] : total(bit); // 演出中は、点が数えられるのに合わせて増やす
    $(bit === P ? "dp" : "dc").textContent = [`WORD ${wordPts[bit]}`, `CROSS ${crossPts[bit]}`, `ISLAND ${islandPts(owner, bit)}`].join("\n");
  }
  // 試合が終わったら、WORD 入力欄とフリックのキーを暗くして、入力できなくする
  $("game-view").classList.toggle("over", over);
  $("game-view").classList.toggle("rank-over", over && mode === "rank"); // ランクマッチ終了: フリックのキーを消して NEXT MATCH を出す
  wordEl.disabled = over;
  renderMarks();
  fitNames(); // 点数の桁数が変わると、名前に使える幅も変わる
  $("pass").disabled = over || turn !== P;
  // 手番のスコア枠を明るく光らせる (終了したら両方消す)
  for (const bit of [P, C]) scoreCards[bit].classList.toggle("active", !over && turn === bit);
}

// 新しくできた単語を長丸 (カプセル) で囲む。盤面の上に重ねた #marks に、マスの位置から計算して描く
function renderMarks() {
  const layer = $("marks");
  layer.replaceChildren();
  if (fxHold) return; // 演出中は出さない (演出が終わってから出す)
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
  // 交点: 細い金色のひし形をゆっくり回す
  for (const k of gems) {
    const el = cellEls[k];
    if (!el) continue;
    const s = el.offsetWidth * GEM_SIZE / Math.SQRT2; // 回転させた正方形の対角線が、マスの GEM_SIZE 倍になる辺の長さ
    const gem = document.createElement("div");
    gem.className = "gem-mark";
    gem.style.left = `${el.offsetLeft + (el.offsetWidth - s) / 2}px`;
    gem.style.top = `${el.offsetTop + (el.offsetHeight - s) / 2}px`;
    gem.style.width = gem.style.height = `${s}px`;
    gem.innerHTML = "<i></i>";
    layer.appendChild(gem);
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

  if (chars.length < MIN_LEN) return fail(`${MIN_LEN}文字以上にしてください`);
  let overlap = 0;
  const news = [];
  const touched = new Set();
  const mainCells = [];
  for (let i = 0; i < chars.length; i++) {
    const rr = r + dr * i, cc = c + dc * i;
    if (rr >= SIZE || cc >= SIZE) return fail("盤面からはみ出します");
    const cur = letters[rr][cc];
    if (cur && cur !== chars[i]) return fail(`「${shown(rr, cc)}」のマスと合いません`);
    if (cur) overlap++;
    else { news.push([rr, cc]); cells.set(rr * SIZE + cc, chars[i]); disp.set(rr * SIZE + cc, rawChars[i]); }
    if (rawChars[i] === chars[i] && SMALL_OF.has(chars[i])) bigIdx.add(rr * SIZE + cc);
    touched.add(rr * SIZE + cc);
    mainCells.push(rr * SIZE + cc);
  }
  const er = r + dr * chars.length, ec = c + dc * chars.length;
  const before = r - dr >= 0 && c - dc >= 0 && letters[r - dr][c - dc];
  const after = er < SIZE && ec < SIZE && letters[er][ec];
  if (before || after) return fail("単語の前後に文字が続いています");
  if (!news.length) return fail("新しい文字を置いてください");
  const level = dict.level(word);
  if (level < 0) return fail(`辞書にありません: ${raw}`);
  if (level > limit) return fail(`難しすぎる語です: ${raw}`);
  if (used.has(word)) return fail(`使用済みです: ${raw}`);

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
      if (lv < 0) return fail(`名詞辞書にありません: ${text}`);
      if (used.has(run.s) || keys.includes(run.s)) return fail(`使用済みです: ${text}`); // 隣り合ってできる語も、同じ語は2回使えない
      if (lv > limit) return fail(`隣り合ってできる語が難しすぎます: ${text}`);
      words.push(text);
      keys.push(run.s);
      runs.push(run.idx);
      run.idx.forEach((k) => touched.add(k));
    }
  }
  if (!overlap && words.length === 1) return fail("盤面の文字とつながっていません");

  // 新しくできた交点: いま縦の単語と横の単語の両方に入っていて、この手より前はそうでなかったマス
  // (単語が変わるのは、この手で新しくできた単語のマスだけなので、touched だけ調べればよい)
  const none = new Map();
  const both = (r, c, tmp) => runAt(r, c, [0, 1], tmp).idx.length >= 2 && runAt(r, c, [1, 0], tmp).idx.length >= 2;
  const interCells = [];
  for (const k of touched) {
    const r = (k / SIZE) | 0, c = k % SIZE;
    if (both(r, c, cells) && !(letters[r][c] && both(r, c, none))) interCells.push(k);
  }
  return { ok: true, words, keys, points: words.reduce((s, w) => s + [...w].length, 0), cells, disp, bigIdx, touched, level, overlap, intersections: interCells.length, interCells, runs };
}

// 手を盤面に反映し、得点の内訳を返す
function apply(res, who) {
  closeScoreDetails();
  moveCount++;
  scoreHold = { [P]: total(P), [C]: total(C) }; // 手を置く前のスコア (演出の間はこの値から数え上げる)
  fxHold = true; // 演出が終わるまで、カプセルとひし形は出さない
  const islandBefore = islandPts(owner, who);
  res.cells.forEach((ch, k) => (letters[(k / SIZE) | 0][k % SIZE] = ch));
  res.bigIdx.forEach((k) => (big[(k / SIZE) | 0][k % SIZE] = true));
  res.touched.forEach((k) => (owner[(k / SIZE) | 0][k % SIZE] |= who));
  const crossing = res.intersections * CROSSING_BONUS;
  wordPts[who] += res.points;
  crossPts[who] += crossing;
  res.keys.forEach((w) => used.add(w));
  marks[who] = res.runs;
  gems = res.interCells; // 新しい交点にひし形を出す (前の手のひし形は消える)
  const islandGain = islandPts(owner, who) - islandBefore;
  const gain = res.points + crossing + islandGain;

  const li = document.createElement("li");
  li.className = who === P ? "p" : "c";
  li.textContent = `${NAME[who]}  ${res.words.join(" + ")}  +${gain}`;
  logEl.prepend(li);

  const items = res.words.map((w, i) => ({ tag: i === 0 ? "WORD" : "TOUCH", text: w, pts: [...w].length }));
  if (crossing) items.push({ tag: "CROSSING", text: `x${res.intersections}`, pts: crossing });
  if (islandGain > 0) items.push({ tag: "ISLAND", text: "", pts: islandGain });
  // 島の得点が増えたときは、この手に関わった島 (10マス以上) を囲んで光らせる
  const island = islandGain > 0 ? islandGroups(owner, who).filter((cells) => cells.length >= ISLAND_STEP && cells.some((k) => res.touched.has(k))) : [];
  return { who, items, total: gain, runs: res.runs, inter: res.interCells, island, islandGain };
}

// ---------- 音声: 置いた単語を読み上げる ----------
// voice.js (VoiceSynth: かなをフォルマント合成する音声エンジン) を使う。声は GIRL、音量は半分。
const VOICE_PRESET = "girl", VOICE_VOLUME = 0.5;
let audioCtx = null;
let speaking = null;
const speechCache = new Map(); // 単語 -> 合成済みの音 (合成は音声1秒あたり約23msかかるので、使い回す)

// 音を出すには、ユーザーの操作 (ボタンを押すなど) の中で AudioContext を作って再開しておく必要がある
function ensureAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  } catch (e) { return null; }
}

function speakWord(text) {
  if (!window.VoiceSynth || !ensureAudio()) return;
  try {
    let buf = speechCache.get(text);
    if (buf === undefined) {
      const list = VoiceSynth.moraList(text); // 小さい字 (っ ゃ など) や ー もそのまま読める
      buf = list.length ? VoiceSynth.render(audioCtx, list, VoiceSynth.params(VOICE_PRESET)) : null;
      speechCache.set(text, buf);
    }
    if (!buf) return;
    try { speaking?.stop(); } catch (e) { /* すでに止まっている */ }
    const src = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();
    gain.gain.value = VOICE_VOLUME;
    src.buffer = buf;
    src.connect(gain).connect(audioCtx.destination);
    src.start();
    speaking = src;
  } catch (e) { /* 音が出せなくてもゲームは続ける */ }
}

// ---------- 得点の演出 ----------
// 手を置いたあとの得点を、1つずつ光らせて数え上げる:
//   1. 単語 (と、隣り合ってできた単語): 文字を1つずつ光らせて +1 ずつ
//   2. 交点: 1か所ずつ大きく光らせて +5 ずつ (6か所あれば6回)
//   3. 島: 島を囲んで光らせて、島の得点を加える
//   4. 合計を大きく出す
// 結果は最低 POP_MIN_MS の間は出し続け、それまではタップで飛ばせない。
// 演出の色: 文字数 = 手を打った側の色 (青 / 赤) / 交点 = 金色 / 島 = 緑系
const GOLD = "#ffe27a", GOLD_DEEP = "#ffb62e", GREEN = "#2bff9a", GREEN_LIGHT = "#b8ffd9";
const FX_SCALE = FAST ? 0.05 : 1; // 動作確認用 (?fast) では、待ち時間を縮める
let fxHold = false; // 演出中: カプセルとひし形は、演出が終わってから出す
let scoreHold = null; // 演出中のスコア欄の値 (点が数えられるのに合わせて増やす)
let popTimer = null, popWake = null, popDone = null, popStart = 0, seqId = 0, skipped = false;
const fxLayer = document.createElement("div"); // 盤面の上に重ねる演出の層
fxLayer.id = "fx";
boardEl.parentElement.append(fxLayer);

const sleepFx = (ms) => new Promise((r) => { popWake = r; popTimer = setTimeout(r, ms * FX_SCALE); });
const escHtml = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function cellBox(k) {
  const el = cellEls[k];
  return { l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2 };
}
function fxEl(cls, x, y, html, css = "") {
  const d = document.createElement("div");
  d.className = cls;
  d.style.cssText = `left:${x}px;top:${y}px;${css}`;
  if (html != null) d.innerHTML = html;
  fxLayer.appendChild(d);
  return d;
}
function fxSparks(x, y, color, n, lo, hi) { // 放射状に飛び散る火花
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + Math.random() * 0.4, dist = lo + Math.random() * (hi - lo);
    const s = fxEl("fx-spark", x, y, null, `background:${color};color:${color};--dx:${Math.cos(ang) * dist}px;--dy:${Math.sin(ang) * dist}px`);
    setTimeout(() => s.remove(), 1000);
  }
}
function fxRing(x, y, color, size, delay = 0) { // 広がる輪
  const r = fxEl("fx-ring", x, y, null, `width:${size}px;height:${size}px;border-color:${color};animation-delay:${delay}ms`);
  setTimeout(() => r.remove(), 900 + delay);
}
function fxFloat(x, y, text, cls, color) { // 浮かび上がる数字
  const f = fxEl("fx-float " + cls, x, y, text, `color:${color}`);
  setTimeout(() => f.remove(), 1300);
}
function flashCell(k, color) {
  const el = cellEls[k];
  el.style.setProperty("--fxc", color); // 光の色
  el.classList.remove("fx-flash");
  void el.offsetWidth; // アニメーションを最初からやり直す
  el.classList.add("fx-flash");
}
// 効果音 (短い電子音。音量は音声と同じく半分)
function blip(hz, dur = 0.09, type = "square", vol = 0.25) {
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    const o = ctx.createOscillator(), gn = ctx.createGain(), t = ctx.currentTime;
    o.type = type;
    o.frequency.value = hz;
    gn.gain.setValueAtTime(vol * VOICE_VOLUME, t);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(gn).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch (e) { /* 音が出せなくても演出は出す */ }
}

// 島を囲んで光らせる: 島の外側に面した辺に、光る線を引く
function fxIsland(cells, color) {
  const set = new Set(cells);
  const outside = (r, c) => !(r >= 0 && c >= 0 && r < SIZE && c < SIZE && set.has(r * SIZE + c));
  let sx = 0, sy = 0;
  for (const k of cells) {
    const r = (k / SIZE) | 0, c = k % SIZE, b = cellBox(k);
    const d = fxEl("fx-island", b.l, b.t, null, `width:${b.w}px;height:${b.h}px;--c:${color}`);
    if (outside(r - 1, c)) d.classList.add("t");
    if (outside(r + 1, c)) d.classList.add("b");
    if (outside(r, c - 1)) d.classList.add("l");
    if (outside(r, c + 1)) d.classList.add("r");
    sx += b.x; sy += b.y;
  }
  return { x: sx / cells.length, y: sy / cells.length };
}

async function runSequence(bd, id) {
  const alive = () => id === seqId && !skipped;
  const col = bd.who === P ? "#c4dbff" : "#ffc2cd"; // 自分の色を明るくした文字色
  let tally = 0;
  const tallyEl = fxEl("fx-tally", 0, 0);
  const setTally = (tag, text, color) => {
    tallyEl.style.color = color;
    tallyEl.style.borderColor = color;
    tallyEl.innerHTML = `<span class="tag">${escHtml(tag)}</span><span class="jp">${escHtml(text)}</span><b>+${tally}</b>`;
    tallyEl.classList.remove("bump");
    void tallyEl.offsetWidth;
    tallyEl.classList.add("bump");
  };
  const add = (n) => { // 点を数える: 合計とスコア欄に加える
    tally += n;
    if (scoreHold) {
      scoreHold[bd.who] += n;
      const el = $(bd.who === P ? "sp" : "sc");
      el.textContent = scoreHold[bd.who];
      fitNames();
      el.classList.remove("bump");
      void el.offsetWidth;
      el.classList.add("bump");
    }
  };

  // 1) 単語: 文字を1つずつ光らせて +1 ずつ。隣り合ってできた単語も、同じように
  for (let w = 0; w < bd.runs.length; w++) {
    const tag = w === 0 ? "WORD" : "TOUCH", text = bd.items[w].text;
    let n = 0;
    for (const k of bd.runs[w]) {
      if (!alive()) return;
      n++;
      const b = cellBox(k);
      flashCell(k, col);
      fxRing(b.x, b.y, col, b.w);
      fxSparks(b.x, b.y, col, 8, b.w * 0.6, b.w * 1.3);
      fxFloat(b.x, b.y, "+1", "small", col);
      blip(520 + n * 48, 0.08);
      add(1);
      setTally(tag, text, col);
      await sleepFx(240);
    }
    await sleepFx(220);
  }

  // 2) 交点: 1か所ずつ大きく光らせて +5 ずつ。6か所あれば6回繰り返す
  for (let i = 0; i < bd.inter.length; i++) {
    if (!alive()) return;
    const k = bd.inter[i], b = cellBox(k);
    flashCell(k, GOLD);
    boardEl.parentElement.classList.remove("fx-shake");
    void boardEl.offsetWidth;
    boardEl.parentElement.classList.add("fx-shake");
    const side = b.w * GEM_SIZE / Math.SQRT2; // 回転させた正方形の対角線が、マスの GEM_SIZE 倍になる辺の長さ
    const d = fxEl("fx-diamond", b.x, b.y, null, `width:${side}px;height:${side}px`);
    setTimeout(() => d.remove(), 900);
    fxRing(b.x, b.y, GOLD, b.w, 0);
    fxRing(b.x, b.y, GOLD_DEEP, b.w, 120);
    fxRing(b.x, b.y, GOLD, b.w, 240);
    fxSparks(b.x, b.y, GOLD, 18, b.w * 1.0, b.w * 2.4);
    fxSparks(b.x, b.y, GOLD_DEEP, 10, b.w * 0.6, b.w * 1.6);
    fxFloat(b.x, b.y, `+${CROSSING_BONUS}`, "big", GOLD);
    blip(880 + i * 110, 0.1, "square", 0.3);
    setTimeout(() => blip(1320 + i * 110, 0.14, "triangle", 0.3), 90);
    add(CROSSING_BONUS);
    setTally(`CROSSING ${i + 1}/${bd.inter.length}`, "", GOLD);
    await sleepFx(640);
  }

  // 3) 島: 島を囲んで光らせて、島の得点を加える
  if (bd.island.length) {
    if (!alive()) return;
    let cx = 0, cy = 0;
    for (const cells of bd.island) { const c = fxIsland(cells, GREEN); cx += c.x; cy += c.y; }
    cx /= bd.island.length; cy /= bd.island.length;
    const size = cellBox(0).w;
    fxRing(cx, cy, GREEN, size * 2);
    fxRing(cx, cy, GREEN_LIGHT, size * 2, 150);
    fxRing(cx, cy, GREEN, size * 2, 300);
    fxSparks(cx, cy, GREEN, 26, size * 1.5, size * 4);
    fxSparks(cx, cy, GREEN_LIGHT, 14, size * 1, size * 3);
    fxFloat(cx, cy, `+${bd.islandGain}`, "huge", GREEN);
    [523, 659, 784, 1047].forEach((hz, j) => setTimeout(() => blip(hz, 0.16, "triangle", 0.3), j * 90));
    add(bd.islandGain);
    setTally("ISLAND", "", GREEN);
    await sleepFx(1300);
  }

  // 4) 合計を大きく出して、最低表示時間まで残す
  if (!alive()) return;
  const box = boardEl.parentElement;
  fxEl("fx-total", box.clientWidth / 2, box.clientHeight / 2, `<span class="tag">${escHtml(NAME[bd.who])}</span><b>+${bd.total}</b>`, `color:${col}`);
  blip(1047, 0.2, "triangle", 0.3);
  const rest = Math.max(POP_HOLD, POP_MIN_MS - (performance.now() - popStart));
  await sleepFx(rest / FX_SCALE);
}

function clearFx() {
  clearTimeout(popTimer);
  fxHold = false;
  scoreHold = null;
  fxLayer.classList.remove("busy");
  fxLayer.replaceChildren();
  boardEl.parentElement.classList.remove("fx-shake");
  for (const el of cellEls) el.classList.remove("fx-flash");
}
function hidePop() { // 演出を止める (新しい対局・画面の移動のとき)
  seqId++;
  clearFx();
  const done = popDone;
  popDone = null;
  if (done) done();
}
function showPop(bd) {
  const id = ++seqId;
  return new Promise((resolve) => {
    popDone = resolve;
    popStart = performance.now();
    skipped = false;
    fxHold = true;
    fxLayer.replaceChildren();
    fxLayer.classList.add("busy");
    runSequence(bd, id).catch(() => { /* 演出が失敗しても、ゲームは続ける */ }).then(() => {
      if (id !== seqId) return; // 途中で止められた
      clearFx();
      render(); // スコア欄の最終値と、カプセル・ひし形を出す
      const done = popDone;
      popDone = null;
      if (done) done();
    });
  });
}
// 演出の層をタップして飛ばせるのは、最低表示時間のあと
fxLayer.addEventListener("click", () => {
  if (performance.now() - popStart < POP_MIN_MS) return;
  skipped = true;
  clearTimeout(popTimer);
  popWake?.();
});

// ---------- ターン進行 ----------

function afterMove(who) {
  marks[turn === P ? C : P] = []; // 手番が終わった: 前の相手の手のカプセルを消す
  passes = who === "pass" ? passes : 0;
  const full = letters.every((row) => row.every(Boolean));
  if (full || passes >= 2) return finish(passes >= 2 ? "2人ともパスしたので終了です" : "盤面が埋まったので終了です");
  turn = turn === P ? C : P;
  render();
  if (turn === C) {
    if (who !== "pass") say("");
    const id = session;
    setTimeout(() => id === session && comTurn(), 0);
  } else {
    focusWord();
  }
}

function finish(reason) {
  over = true;
  render();
  const a = total(P), b = total(C);
  const rk = recordRank(a, b);
  showResultFaces(a, b); // 勝った方は喜び、負けた方は悲しい顔に
  say(`${reason}。${a === b ? "引き分け" : a > b ? "あなたの勝ち" : `${NAME[C]}の勝ち`} ${a} - ${b}${rankText(rk)}`);
  if (a > b) showVictory(a, b, rk); // 勝ったときは派手な演出
}

async function playerMove(word, r, c, dir) {
  const res = check(word, r, c, dir);
  if (!res.ok) return say(res.error, true);
  const id = session;
  const bd = apply(res, P);
  speakWord(res.words[0]);
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
  closeScoreDetails();
  passes++;
  const li = document.createElement("li");
  li.className = who === P ? "p" : "c";
  li.textContent = `${NAME[who]}  PASS`;
  logEl.prepend(li);
  // 2人が続けてパスすると終了 (afterMove の中で終了なら結果の表示に置き換わる)
  say(who === P ? "パスしました。相手もパスすると終了します" : `${NAME[C]}がパスしました。あなたもパスすると終了します`);
  afterMove("pass");
}

// ---------- COM ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function comTurn() {
  const id = session;
  const t0 = performance.now();
  await sleep(50); // 手番の枠が光るのを先に描かせてから、探索を始める
  const move = comSearch();
  const wait = COM_THINK_MS - (performance.now() - t0); // 「考えている」時間を最低 COM_THINK_MS にそろえる
  if (wait > 0) await sleep(wait);
  if (id !== session) return;
  if (!move) return pass(C);
  const bd = apply(move.res, C);
  speakWord(move.res.words[0]);
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
  if (!currentWord()) return say("単語を入力してください", true);
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
  say(res.ok ? `+${res.points}点` : res.error, !res.ok);
});

boardEl.addEventListener("pointerup", (e) => {
  if (!drag) return;
  const { r, c } = drag;
  const dir = dragDir(e);
  drag = null;
  render();
  if (dir) playerMove(currentWord(), r, c, dir);
  else say("開始マスから右か下へドラッグしてください");
});
boardEl.addEventListener("pointercancel", () => { drag = null; render(); });

wordEl.addEventListener("change", () => (wordEl.value = currentWord()));
wordEl.addEventListener("input", updateWordStatus);

// ---------- スマホ用: 盤面の下に日本語のフリック入力を再現 ----------
// 各キー: [中央(タップ), 左, 上, 右, 下] の順 (iOS のフリック入力と同じ)
const FLICK_KEYS = [
  ["あ", "いうえお"], ["か", "きくけこ"], ["さ", "しすせそ"],
  ["た", "ちつてと"], ["な", "にぬねの"], ["は", "ひふへほ"],
  ["ま", "みむめも"], ["や", "-ゆ-よ"], ["ら", "りるれろ"],
];
const WA_KEY = ["わ", "をん-ー"]; // 中央 わ / 左 を / 上 ん / 右 (なし: "-") / 下 ー
const CYCLES = ["あぁ", "いぃ", "うぅゔ", "えぇ", "おぉ", "かが", "きぎ", "くぐ", "けげ", "こご", "さざ", "しじ", "すず", "せぜ", "そぞ",
  "ただ", "ちぢ", "つっづ", "てで", "とど", "はばぱ", "ひびぴ", "ふぶぷ", "へべぺ", "ほぼぽ", "やゃ", "ゆゅ", "よょ", "わゎ"];
const MAX_INPUT = 12;

function padInsert(ch) {
  if ([...wordEl.value].length < MAX_INPUT) wordEl.value += ch;
  updateWordStatus();
}
function padTransform() { // 小 ゛ ゜: 直前の字を小さい字/濁音/半濁音に切り替える
  const chars = [...wordEl.value];
  const last = chars.pop();
  const cyc = CYCLES.find((c) => c.includes(last));
  if (!cyc) return;
  chars.push(cyc[(cyc.indexOf(last) + 1) % cyc.length]);
  wordEl.value = chars.join("");
  updateWordStatus();
}

function buildKeypad() {
  const pad = $("kana-pad");
  // キー1つの幅 (--k) と高さ (--kh) は fitBoard が画面の大きさから決める
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
    // 押したキーの上に指がある間は、中央の文字 (タップ)。キーから指が離れたら、そこにある候補を選ぶ
    // (どの候補の上でもなければ、中心からの向きで選ぶ)。小さく動かしただけでは、フリックにならない
    const dirOf = (e) => {
      const k = st.keyRect;
      if (e.clientX >= k.left && e.clientX <= k.right && e.clientY >= k.top && e.clientY <= k.bottom) return 0;
      for (const { d, r } of st.rects) {
        if (d === 0) continue;
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return d;
      }
      const dx = e.clientX - st.cx, dy = e.clientY - st.cy;
      return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 1 : 3) : dy < 0 ? 2 : 4;
    };
    const mark = (d) => btn.querySelectorAll(".fg").forEach((el) => el.classList.toggle("sel", el.classList.contains(dirs[d])));
    btn.addEventListener("pointerdown", (e) => {
      const b = btn.getBoundingClientRect();
      btn.setPointerCapture(e.pointerId);
      btn.classList.add("down");
      const rects = [...btn.querySelectorAll(".fg")].map((el) => ({ d: dirs.indexOf(el.className.split(" ")[1]), r: el.getBoundingClientRect() }));
      st = { cx: b.left + b.width / 2, cy: b.top + b.height / 2, keyRect: b, rects, d: 0 };
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
  // 下段: 小゛゜ / わ / DEL (ー は わ の下フリック)
  pad.append(action("小゛゜", "small", padTransform, "small kana or dakuten"));
  pad.append(flickKey(...WA_KEY));
  pad.append(action("DEL", "del", () => { wordEl.value = [...wordEl.value].slice(0, -1).join(""); updateWordStatus(); }, "delete"));
}

// タッチ端末では、端末のキーボードの代わりに盤面の下のキーパッドで入力する (?keypad=1 で PC でも確認できる)
if (matchMedia("(hover: none) and (pointer: coarse)").matches || new URLSearchParams(location.search).has("keypad")) {
  document.body.classList.add("keypad");
  wordEl.inputMode = "none";
  buildKeypad();
}
// スコアをタップすると内訳 (WORD / CROSS / ISLAND) を開閉する
for (const card of document.querySelectorAll(".sc")) {
  const toggle = () => {
    const opening = !card.classList.contains("open");
    closeScoreDetails(); // 開くときは、もう一方の内訳を閉じる
    if (opening) { card.classList.add("open"); card.setAttribute("aria-expanded", "true"); }
  };
  card.addEventListener("click", toggle);
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
}
$("pass").addEventListener("click", () => { if (dict && !over && !busy && turn === P) pass(P); });

for (const btn of document.querySelectorAll(".level-choice")) {
  btn.addEventListener("click", () => {
    if (!dict) return;
    ensureAudio(); // 音を出せるように、ボタンを押したこの場で用意しておく
    if (btn.dataset.level === "rank") { renderRank(); navigate("rank"); }
    else startLevel(btn.dataset.level);
  });
}
// ランクマッチ: 相手は選べない。試合開始を押すと、自分の順位の上下30位以内から1人が決まる。順位の高い方が先攻
// 対戦前の紹介: 左上にあなた、右下に相手、真ん中に VS とこれまでの対戦成績。少し見せてから (タップで早送り) 試合を始める
let vsTimer = 0, vsGo = null;
function showVsIntro(pick, me, first) {
  const c = roster.find((x) => x.name === pick.name), h = rankBook.headToHead(pick.name);
  $("vs-you-face").replaceChildren();
  paintPlayerFace($("vs-you-face"));
  $("vs-you-name").textContent = avatar.name;
  $("vs-you-info").textContent = `RANK ${me.rank}  RATING ${Math.round(me.rating)}`;
  $("vs-com-face").innerHTML = faceHTML(c);
  $("vs-com-name").textContent = c.name;
  $("vs-com-info").textContent = `RANK ${pick.rank}  RATING ${Math.round(pick.rating)}`;
  $("vs-rec").innerHTML = h.w + h.l + h.d ? `<small>HEAD TO HEAD</small>WIN ${h.w} / LOSE ${h.l} / DRAW ${h.d}` : "<small>HEAD TO HEAD</small>FIRST MATCH";
  const box = $("vs-intro");
  box.hidden = false;
  box.classList.remove("go"); void box.offsetWidth; box.classList.add("go"); // アニメーションを最初から
  vsGo = () => { clearTimeout(vsTimer); vsGo = null; box.hidden = true; startRank(pick.name, first); };
  vsTimer = setTimeout(vsGo, FAST ? 150 : 3200);
}
$("vs-intro").addEventListener("click", () => vsGo?.());

$("rank-start").addEventListener("click", () => {
  if (!dict || !rankBook) return;
  ensureAudio();
  const { me, rows } = rankBook.nearby(); // 1 位から最下位まで全員
  const pool = rows.filter((r) => !r.isPlayer && Math.abs(r.rank - me.rank) <= NEAR); // 上下 NEAR 位以内
  const pick = pool[Math.floor(Math.random() * pool.length)];
  showVsIntro(pick, me, pick.rank < me.rank ? C : P);
});
$("rank-back").addEventListener("click", () => history.back());
// ランクマッチが終わったら、そのまま次の対戦相手を選んで対戦前の紹介へ
$("next-match").addEventListener("click", () => {
  if (!dict || !rankBook || !over || mode !== "rank") return;
  ensureAudio();
  hideVictory();
  const { me, rows } = rankBook.nearby();
  const pool = rows.filter((r) => !r.isPlayer && Math.abs(r.rank - me.rank) <= NEAR);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  showVsIntro(pick, me, pick.rank < me.rank ? C : P);
});

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
$("help-open").addEventListener("click", () => { navigate("help"); window.scrollTo(0, 0); });
$("help-back").addEventListener("click", () => history.back());

// ---------- キャラクターエディット ----------
function buildEditor() {
  if (!PD) { $("edit-open").hidden = true; return; }
  const groups = [
    ["edit-hair", "hair", PD.options.hair], ["edit-eyes", "eyes", PD.options.eyes], ["edit-mouth", "mouth", PD.options.mouth],
    ["edit-hair-color", "hairColor", PD.palettes.hair], ["edit-cloth-color", "clothColor", PD.palettes.cloth], ["edit-skin-color", "skinColor", PD.palettes.skin],
  ];
  const options = [];
  const refresh = () => {
    repaintPlayer();
    for (const { button, key, value, preview } of options) {
      button.hidden = key === "mouth" && value === "mouth8" && avatar.hair.endsWith("w");
      const on = avatar[key] === value;
      button.classList.toggle("selected", on);
      button.setAttribute("aria-pressed", String(on));
      if (key === "hair") paintMask(preview, PD.layerMasks.hair[value], avatar.hairColor); // 髪型の見本は、いまの髪の色で
    }
  };
  for (const [id, key, values] of groups) {
    for (const value of values) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "edit-option";
      button.setAttribute("aria-label", `${key} ${value}`);
      let preview = null;
      if (key.endsWith("Color")) { button.classList.add("color"); button.style.background = value; }
      else if (key === "hair") { preview = document.createElement("canvas"); preview.width = preview.height = 16; button.append(preview); }
      else { preview = document.createElement("img"); preview.alt = ""; preview.src = `characters/parts/${value}.png`; button.append(preview); }
      button.addEventListener("click", () => {
        if (key === "mouth" && value === "mouth8" && avatar.hair.endsWith("w")) return;
        avatar[key] = value;
        if (key === "hair" && value.endsWith("w") && avatar.mouth === "mouth8") avatar.mouth = PD.defaults.mouth;
        saveAvatar();
        refresh();
      });
      $(id).append(button);
      options.push({ button, key, value, preview });
    }
  }
  const nameInput = $("edit-name");
  nameInput.value = avatar.name;
  nameInput.addEventListener("input", () => {
    const name = nameInput.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    nameInput.value = name;
    if (!name) return;
    avatar.name = name;
    NAME[P] = name;
    saveAvatar();
    repaintPlayer();
  });
  nameInput.addEventListener("blur", () => { if (!nameInput.value) nameInput.value = avatar.name; });
  // 表情の見本 (ふつう / 勝ち / 負け)
  const exprButtons = [...document.querySelectorAll("#edit-expr button")];
  for (const b of exprButtons) {
    b.addEventListener("click", () => {
      setExpression($("edit-face"), b.dataset.expr, true);
      for (const o of exprButtons) o.classList.toggle("selected", o === b);
    });
  }
  refresh();
}
buildEditor();
repaintPlayer();
$("edit-open").addEventListener("click", () => navigate("edit"));
$("edit-back").addEventListener("click", () => history.back());

// ---------- 画面の移動とブラウザの「戻る」 ----------
// 画面を進めるたびに履歴を積む。ブラウザの「戻る」を押しても、アプリの外に出ずに1つ前の画面へ戻る
// (対局中に「戻る」を押したときは、抜けてよいかを確認する)
history.replaceState({ view: "title" }, "");
function navigate(name) {
  history.pushState({ view: name }, "");
  showView(name);
}
let leaving = false; // 対局を抜けると確認済み
// 抜けるときに確認が必要な対局か。1 手でも打っていたら (ランクマッチは抜けるとキャンセルになり、順位には影響しない)
const gameInProgress = () => currentView === "game" && !over && !leaving && logEl.children.length > 0;
function askLeave() {
  const ranked = mode === "rank";
  $("leave-text").textContent = ranked ? "MENUに戻りますか？" : "LEAVE THIS GAME?";
  $("leave-text").classList.toggle("jp", ranked);
  $("leave-confirm").hidden = false;
}
addEventListener("popstate", (e) => {
  const target = e.state?.view || "title";
  if (currentView === "game" && target !== "game" && gameInProgress()) {
    history.pushState({ view: "game" }, ""); // 画面は動かさずに、確認を出す
    askLeave();
    return;
  }
  if (currentView === "game") { session++; hidePop(); hideVictory(); $("leave-confirm").hidden = true; }
  leaving = false;
  if (target === "rank") renderRank();
  showView(target);
});
// MENU: 対局中なら確認してから戻る
$("menu-back").addEventListener("click", () => {
  if (gameInProgress()) askLeave();
  else history.back();
});
$("leave-yes").addEventListener("click", () => {
  $("leave-confirm").hidden = true;
  leaving = true;
  history.back();
});
$("leave-no").addEventListener("click", () => { $("leave-confirm").hidden = true; focusWord(); });

// ---------- スコアの内訳: 他の操作が行われたら閉じる ----------
function closeScoreDetails() {
  for (const card of document.querySelectorAll(".sc.open")) {
    card.classList.remove("open");
    card.setAttribute("aria-expanded", "false");
  }
}
document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".sc")) closeScoreDetails(); }, true);
document.addEventListener("keydown", (e) => { if (!e.target.closest?.(".sc")) closeScoreDetails(); }, true);

// ---------- 勝ったときの演出 ----------
let victoryStart = 0, victoryTimer = null;

function hideVictory() {
  clearInterval(victoryTimer);
  $("victory").hidden = true;
  $("vic-fx").replaceChildren();
}

// 短いファンファーレ (WebAudio。音量は音声と同じ半分)
function fanfare() {
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime + 0.05;
    const master = ctx.createGain();
    master.gain.value = VOICE_VOLUME * 0.5;
    master.connect(ctx.destination);
    const note = (hz, at, dur, type = "square") => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(0.5, t0 + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(g).connect(master);
      o.start(t0 + at);
      o.stop(t0 + at + dur + 0.05);
    };
    [[523.25, 0], [659.25, 0.12], [783.99, 0.24], [1046.5, 0.36], [783.99, 0.6], [1046.5, 0.72]].forEach(([hz, at]) => note(hz, at, 0.16));
    [523.25, 659.25, 783.99, 1046.5].forEach((hz) => note(hz, 0.9, 1.0, "triangle")); // 最後の和音
  } catch (e) { /* 音が出せなくても演出は出す */ }
}

// 紙吹雪と花火
function showVictory(a, b, rk) {
  const v = $("victory"), fx = $("vic-fx");
  $("vic-score").textContent = `${a} - ${b}`;
  $("vic-rank").textContent = rk ? `RANK ${rk.oldRank} > ${rk.newRank}    ${rk.delta >= 0 ? "+" : ""}${rk.delta}` : "";
  setExpression($("vic-face"), "win", true);
  fx.replaceChildren();
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const colors = ["#e8e070", "#8db8ff", "#ff8da1", "#cfa6ff", "#57ffb6", "#ffffff"];
  // 紙吹雪: 大きさは 1.5 倍、落ちる速さは 6 割 (= 落ちるのにかかる時間は 1/0.6 倍)
  for (let i = 0; i < 90; i++) {
    const c = document.createElement("i");
    c.className = "conf";
    c.style.cssText = `left:${rand(0, 100)}%;width:${rand(9, 18)}px;height:${rand(15, 30)}px;background:${colors[i % colors.length]};` +
      `animation-delay:${rand(0, 4)}s;animation-duration:${rand(2.6, 5) / 0.6}s;--r:${rand(-720, 720)}deg;--x:${rand(-60, 60)}px`;
    fx.appendChild(c);
  }
  for (let i = 0; i < 18; i++) { // ゆらゆら揺れながら落ちる紙
    const w = document.createElement("i");
    w.className = "flut";
    w.style.cssText = `left:${rand(3, 97)}%;width:${rand(14, 22)}px;height:${rand(20, 32)}px;background:${colors[i % colors.length]};` +
      `animation-delay:${rand(0, 5)}s;animation-duration:${rand(7, 11)}s,${rand(1.6, 2.6)}s,${rand(1.1, 1.8)}s;--sway:${rand(30, 70)}px`;
    fx.appendChild(w);
  }
  const burst = () => { // 花火: 中心から放射状に飛び散る
    const cx = rand(15, 85), cy = rand(12, 55), col = colors[Math.floor(Math.random() * colors.length)];
    const n = 16;
    for (let i = 0; i < n; i++) {
      const s = document.createElement("i");
      s.className = "spark";
      const ang = (i / n) * Math.PI * 2, dist = rand(60, 120);
      s.style.cssText = `left:${cx}%;top:${cy}%;background:${col};--dx:${Math.cos(ang) * dist}px;--dy:${Math.sin(ang) * dist}px`;
      fx.appendChild(s);
      setTimeout(() => s.remove(), 1400);
    }
  };
  burst();
  clearInterval(victoryTimer);
  victoryTimer = setInterval(burst, 550);
  victoryStart = performance.now();
  v.hidden = false;
  fanfare();
}
$("victory").addEventListener("click", () => { if (performance.now() - victoryStart > 1200) hideVictory(); });

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
      scoreHold = null;
      fxHold = false;
      render();
      return { ok: true, shown: letters.map((row, rr) => row.map((ch, cc) => (ch ? shown(rr, cc) : "・")).join("")) };
    },
    victory: (a, b, rk) => showVictory(a, b, rk), // 勝利演出を確かめる
    // 得点を直接決めて対局を終わらせる (勝ち・負けの流れを確かめる)
    endWith(p, c) { wordPts[P] = p; wordPts[C] = c; finish("テスト"); },
    comSearch: () => { const m = comSearch(); return m && { words: m.res.words, points: m.res.points, level: m.res.level }; },
    check: (raw, r, c, dir) => {
      const res = check(raw, r, c, dir);
      return res.ok ? { ok: true, words: res.words, points: res.points, intersections: res.intersections, overlap: res.overlap, runs: res.runs } : { ok: false, error: res.error };
    },
  };
}

// ランクの一覧: マウスでもドラッグでスクロールでき、離したあとは慣性でゆっくり止まる (タッチは標準の慣性スクロール)
{
  const list = $("rank-list");
  let down = false, startY = 0, startTop = 0, moved = false, lastY = 0, lastT = 0, vel = 0, raf = 0;
  list.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") return;
    cancelAnimationFrame(raf);
    down = true; moved = false; startY = lastY = e.clientY; startTop = list.scrollTop; lastT = performance.now(); vel = 0;
  });
  window.addEventListener("pointermove", (e) => {
    if (!down) return;
    if (!moved && Math.abs(e.clientY - startY) < 4) return;
    moved = true;
    list.classList.add("dragging");
    list.scrollTop = startTop - (e.clientY - startY);
    const now = performance.now(), dt = Math.max(1, now - lastT);
    vel = 0.8 * vel + 0.2 * ((lastY - e.clientY) / dt); // px/ms
    lastY = e.clientY; lastT = now;
  });
  const up = () => {
    if (!down) return;
    down = false;
    list.classList.remove("dragging");
    if (performance.now() - lastT > 80) vel = 0; // 止めてから離したら慣性なし
    let prev = performance.now();
    const step = (t) => {
      const dt = t - prev; prev = t;
      list.scrollTop += vel * dt;
      vel *= Math.pow(0.995, dt); // だんだん遅くなる
      if (Math.abs(vel) > 0.02) raf = requestAnimationFrame(step);
    };
    if (moved) raf = requestAnimationFrame(step);
  };
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  list.addEventListener("click", (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
}
