// ランクマッチ用のランキング。チェスと同じ Elo 方式 (勝てば上がり、格上に勝つほど大きく上がる)。
// - あなた (YOU) と COM のキャラクター99人が、同じ1つのランキングに並ぶ
// - あなたは自分の順位の上下 NEAR 人と対戦する
// - 1日の最初の起動のときに、COM 同士の対戦をまとめて行って COM の順位も入れ替える
// データはこのブラウザの localStorage に保存する (保存できない環境では、開いている間だけ覚える)

export const PLAYER = "YOU";
export const NEAR = 20; // 自分の順位の上下何人と戦うか
const KEY = "xwordx.rank.v1";
const START_RATING = 1500;
const K_PLAYER = 96, K_COM_MATCH = 72; // あなたとの対戦での、1戦での動きの大きさ (大きいほど勝敗が順位に強く効く)
export const HISTORY_MAX = 100;
const K_COM = 24; // COM どうしの毎日の更新での動きの大きさ
const DRAW_RATE = 0.08; // COM 同士の対戦が引き分けになる割合
const DAILY_MATCHES_PER_COM = 4; // 1日の更新で、COM 1人あたり何戦するか

const pad = (n) => String(n).padStart(2, "0");
export function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 日付から決まる乱数 (同じ日付なら同じ結果になる)
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const expected = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400)); // ra が rb に勝つ見込み (0〜1)
export const initialRating = (strength) => 1000 + strength * 9; // 強さ 18〜95 -> 約 1160〜1860

export class RankBook {
  constructor(roster) {
    this.roster = roster;
    this.byName = new Map(roster.map((c) => [c.name, c]));
    this.state = this._load();
  }

  _fresh() {
    const ratings = {};
    for (const c of this.roster) ratings[c.name] = initialRating(c.strength);
    return {
      v: 1,
      player: { rating: Math.min(START_RATING, ...Object.values(ratings)) - 1, // 最下位 (100 位) から始める
         games: 0, wins: 0, losses: 0, draws: 0 },
      ratings,
      prevRanks: {}, // 前回の更新の直前の順位 (順位の上がり下がりの表示用)
      history: [], // ランクマッチの対戦履歴 (新しい順、最大 HISTORY_MAX 件)
      h2h: {}, // 相手ごとの、あなたの対戦成績 { 名前: { w, l, d } }
      lastDaily: "", // 最後に COM 同士の更新をした日
      daily: null, // その更新の内容 { date, matches }
    };
  }

  _load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.v === 1 && s.player && s.ratings) {
        if (!s.h2h) s.h2h = {};
        if (!Array.isArray(s.history)) s.history = [];
        for (const c of this.roster) if (typeof s.ratings[c.name] !== "number") s.ratings[c.name] = initialRating(c.strength);
        return s;
      }
    } catch (e) { /* 読めなければ初期状態から */ }
    return this._fresh();
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch (e) { /* 保存できなくても動く */ }
  }

  // 全員の順位表 (レーティングの高い順)。rank は 1 から
  standings() {
    const rows = this.roster.map((c) => ({ name: c.name, rating: this.state.ratings[c.name], isPlayer: false }));
    rows.push({ name: PLAYER, rating: this.state.player.rating, isPlayer: true });
    rows.sort((a, b) => b.rating - a.rating || (a.name < b.name ? -1 : 1));
    rows.forEach((r, i) => (r.rank = i + 1));
    return rows;
  }

  // あなたと、その相手との対戦成績
  headToHead(name) { return this.state.h2h[name] || { w: 0, l: 0, d: 0 }; }

  playerRank() { return this.standings().find((r) => r.isPlayer).rank; }

  // 前回の更新から順位がどれだけ上がったか (プラス = 上がった)
  rankChange(name, rank) {
    const prev = this.state.prevRanks[name];
    return prev ? prev - rank : 0;
  }

  // 自分の順位の上下 NEAR 人 (自分の行も含む)。順位の高い順
  nearby() {
    const all = this.standings();
    const me = all.find((r) => r.isPlayer);
    return { me, rows: all.map((r) => ({ ...r, change: this.rankChange(r.name, r.rank) })) };
  }

  // 対戦相手になれる人 (順位の高い順)。
  // 自分の上下 NEAR 位以内が基本。ただし自分が NEAR 位以内にいるときは、自分より強い人数 (順位 - 1) と同じ人数だけ下の順位とも戦う
  // (20 位なら上下 19 人、10 位なら上下 9 人、2 位なら 1 位と 3 位)。1 位だけは相手がいなくなるので 2〜5 位と戦う
  opponentPool() {
    const all = this.standings();
    const me = all.find((r) => r.isPlayer);
    const k = Math.min(NEAR, me.rank - 1);
    const lo = me.rank === 1 ? 2 : me.rank - k, hi = me.rank === 1 ? 5 : me.rank + k;
    return { me, rows: all.filter((r) => !r.isPlayer && r.rank >= lo && r.rank <= hi) };
  }

  // 対戦結果を反映する。result: 1=あなたの勝ち, 0.5=引き分け, 0=あなたの負け。score: "40-10" のような得点 (履歴用)
  record(oppName, result, score = "") {
    const before = this.standings();
    const oldRank = before.find((r) => r.isPlayer).rank;
    const oppRank = before.find((r) => r.name === oppName).rank;
    const p = this.state.player, ra = p.rating, rb = this.state.ratings[oppName];
    const e = expected(ra, rb);
    const dp = K_PLAYER * (result - e);
    p.rating = ra + dp;
    this.state.ratings[oppName] = rb - K_COM_MATCH * (result - e);
    p.games++;
    const h = (this.state.h2h[oppName] ||= { w: 0, l: 0, d: 0 });
    if (result === 1) h.w++; else if (result === 0) h.l++; else h.d++;
    if (result === 1) p.wins++; else if (result === 0) p.losses++; else p.draws++;
    this._othersPlay(oppName);
    const newRank0 = this.playerRank();
    this.state.history.unshift({ t: Date.now(), date: todayString(), opp: oppName, oppRank, result, score, oldRank, newRank: newRank0 });
    this.state.history.length = Math.min(this.state.history.length, HISTORY_MAX);
    this.save();
    const newRank = newRank0;
    return { oldRank, newRank, delta: Math.round(p.rating) - Math.round(ra), rating: Math.round(p.rating) };
  }

  // あなたが1戦するたびに、あなたの相手以外の COM の半分も、(レーティングの近い) 誰かと1戦する
  _othersPlay(oppName) {
    const st = this.state;
    const pool = this.roster.map((c) => c.name).filter((n) => n !== oppName);
    for (let i = pool.length - 1; i > 0; i--) { // 無作為に半分を選ぶ
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const half = pool.slice(0, Math.floor(pool.length / 2)).sort((x, y) => st.ratings[y] - st.ratings[x]);
    for (let i = 0; i + 1 < half.length; i += 2) { // 近いレーティングどうしで2人ずつ対戦
      const a = half[i], b = half[i + 1];
      const ra = st.ratings[a], rb = st.ratings[b], e = expected(ra, rb);
      const s = Math.random() < DRAW_RATE ? 0.5 : Math.random() < e ? 1 : 0;
      st.ratings[a] = ra + K_COM * (s - e);
      st.ratings[b] = rb - K_COM * (s - e);
    }
  }

  // 1日の最初の起動で、COM 同士の対戦を行って順位を入れ替える。行ったら true
  dailyUpdate() {
    const date = todayString();
    if (this.state.lastDaily === date) return false;
    const rng = mulberry32(hash(date));
    const st = this.state;
    st.prevRanks = {};
    for (const r of this.standings()) st.prevRanks[r.name] = r.rank;

    const names = this.roster.map((c) => c.name);
    const matches = names.length * DAILY_MATCHES_PER_COM;
    for (let i = 0; i < matches; i++) {
      const a = names[Math.floor(rng() * names.length)];
      // 相手は、順位の近い COM から選ぶ (あなたは含めない)
      const order = this.standings();
      const ia = order.findIndex((r) => r.name === a);
      const rank = ia + 1; // あなたと同じ決め方: 上下 NEAR 位以内。ただし上位は、上にいる人数と同じ人数だけ下と戦う。1 位は 2〜5 位
      const k = Math.min(NEAR, rank - 1);
      const lo = rank === 1 ? 2 : rank - k, hi = rank === 1 ? 5 : rank + k;
      const near = order.filter((r, j) => !r.isPlayer && r.name !== a && j + 1 >= lo && j + 1 <= hi);
      if (!near.length) continue;
      const b = near[Math.floor(rng() * near.length)].name;
      const ra = st.ratings[a], rb = st.ratings[b], e = expected(ra, rb);
      const s = rng() < DRAW_RATE ? 0.5 : rng() < e ? 1 : 0;
      st.ratings[a] = ra + K_COM * (s - e);
      st.ratings[b] = rb - K_COM * (s - e);
    }
    if (st.player.games === 0) st.player.rating = Math.min(...Object.values(st.ratings)) - 1; // まだ対戦していないあなたは、最下位のまま
    st.lastDaily = date;
    st.daily = { date, matches };
    this.save();
    return true;
  }
}
