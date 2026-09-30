// ランクマッチ用のランキング。チェスと同じ Elo 方式 (勝てば上がり、格上に勝つほど大きく上がる)。
// - あなた (YOU) と COM のキャラクター99人が、同じ1つのランキングに並ぶ
// - あなたは自分の順位の上下 NEAR 人と対戦する
// - 1日の最初の起動のときに、COM 同士の対戦をまとめて行って COM の順位も入れ替える
// データはこのブラウザの localStorage に保存する (保存できない環境では、開いている間だけ覚える)

export const PLAYER = "YOU";
export const NEAR = 10; // 自分の順位の上下何人と戦うか
const KEY = "xwordx.rank.v1";
const START_RATING = 1500;
const K_PLAYER = 32, K_COM = 24; // 1戦での動きの大きさ
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
      player: { rating: START_RATING, games: 0, wins: 0, losses: 0, draws: 0 },
      ratings,
      prevRanks: {}, // 前回の更新の直前の順位 (順位の上がり下がりの表示用)
      lastDaily: "", // 最後に COM 同士の更新をした日
      daily: null, // その更新の内容 { date, matches }
    };
  }

  _load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.v === 1 && s.player && s.ratings) {
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
    return { me, rows: all.filter((r) => Math.abs(r.rank - me.rank) <= NEAR).map((r) => ({ ...r, change: this.rankChange(r.name, r.rank) })) };
  }

  // 対戦結果を反映する。result: 1=あなたの勝ち, 0.5=引き分け, 0=あなたの負け
  record(oppName, result) {
    const before = this.standings();
    const oldRank = before.find((r) => r.isPlayer).rank;
    const p = this.state.player, ra = p.rating, rb = this.state.ratings[oppName];
    const e = expected(ra, rb);
    const dp = K_PLAYER * (result - e);
    p.rating = ra + dp;
    this.state.ratings[oppName] = rb - K_COM * (result - e);
    p.games++;
    if (result === 1) p.wins++; else if (result === 0) p.losses++; else p.draws++;
    this.save();
    const newRank = this.playerRank();
    return { oldRank, newRank, delta: Math.round(p.rating) - Math.round(ra), rating: Math.round(p.rating) };
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
      const near = order.filter((r, j) => !r.isPlayer && r.name !== a && Math.abs(j - ia) <= NEAR);
      if (!near.length) continue;
      const b = near[Math.floor(rng() * near.length)].name;
      const ra = st.ratings[a], rb = st.ratings[b], e = expected(ra, rb);
      const s = rng() < DRAW_RATE ? 0.5 : rng() < e ? 1 : 0;
      st.ratings[a] = ra + K_COM * (s - e);
      st.ratings[b] = rb - K_COM * (s - e);
    }
    st.lastDaily = date;
    st.daily = { date, matches };
    this.save();
    return true;
  }
}
