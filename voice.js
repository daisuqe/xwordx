/* Nodegram VOICE ノードの音声合成エンジン。
   日本語のかな列をフォルマント合成でオフライン生成する。外部データは使わない。
   出力は AudioBuffer なので、再生時のコストは通常の効果音と変わらない。
   生成そのものは音声1秒あたり約23msかかるため、必ず事前に焼いてから使うこと。 */
(function(global){
  "use strict";

  var VOWELS = {
    a:[[ 892,1.00],[1481,0.42],[2961,0.14]],
    i:[[ 356,1.00],[2783,0.36],[3444,0.15]],
    u:[[ 443,1.00],[1651,0.30],[2820,0.11]],
    e:[[ 533,1.00],[2334,0.42],[3055,0.16]],
    o:[[ 520,1.00],[ 984,0.44],[3000,0.10]],
    N:[[ 260,1.00],[1200,0.16],[2400,0.06]]
  };
  var VNAME = {a:"あ",i:"い",u:"う",e:"え",o:"お",N:"ん"};

  /* ============ 子音 ============ */
  var CONS = {
    "" :{t:"none"},
    k:{t:"stop", hz:2400,q:1.8,clo:0.048,bd:0.014,amp:0.30},
    g:{t:"stop", hz:1700,q:1.8,clo:0.034,bd:0.012,amp:0.18},
    t:{t:"stop", hz:3400,q:2.2,clo:0.046,bd:0.010,amp:0.30},
    d:{t:"stop", hz:2500,q:2.0,clo:0.034,bd:0.010,amp:0.18},
    p:{t:"stop", hz:1050,q:1.5,clo:0.046,bd:0.012,amp:0.24},
    b:{t:"stop", hz: 880,q:1.5,clo:0.032,bd:0.012,amp:0.16},
    s:{t:"fric", hz:6200,q:1.1,dur:0.090,amp:0.13},
    S:{t:"fric", hz:3600,q:1.0,dur:0.095,amp:0.14},
    z:{t:"fric", hz:4600,q:1.1,dur:0.050,amp:0.09},
    h:{t:"fric", hz:1500,q:0.7,dur:0.072,amp:0.10},
    F:{t:"fric", hz:1100,q:0.6,dur:0.075,amp:0.10},
    c:{t:"stop", hz:3000,q:1.6,clo:0.042,bd:0.030,amp:0.20},
    n:{t:"nas",  dur:0.055},
    m:{t:"nas",  dur:0.060},
    r:{t:"tap",  dur:0.024},
    y:{t:"gld",  from:"i"},
    w:{t:"gld",  from:"u"}
  };

  /* ============ かな → [子音, 母音] ============ */
  var KANA = {
    "あ":["","a"],"い":["","i"],"う":["","u"],"え":["","e"],"お":["","o"],
    "か":["k","a"],"き":["k","i"],"く":["k","u"],"け":["k","e"],"こ":["k","o"],
    "が":["g","a"],"ぎ":["g","i"],"ぐ":["g","u"],"げ":["g","e"],"ご":["g","o"],
    "さ":["s","a"],"し":["S","i"],"す":["s","u"],"せ":["s","e"],"そ":["s","o"],
    "ざ":["z","a"],"じ":["z","i"],"ず":["z","u"],"ぜ":["z","e"],"ぞ":["z","o"],
    "た":["t","a"],"ち":["c","i"],"つ":["c","u"],"て":["t","e"],"と":["t","o"],
    "だ":["d","a"],"ぢ":["z","i"],"づ":["z","u"],"で":["d","e"],"ど":["d","o"],
    "な":["n","a"],"に":["n","i"],"ぬ":["n","u"],"ね":["n","e"],"の":["n","o"],
    "は":["h","a"],"ひ":["h","i"],"ふ":["F","u"],"へ":["h","e"],"ほ":["h","o"],
    "ば":["b","a"],"び":["b","i"],"ぶ":["b","u"],"べ":["b","e"],"ぼ":["b","o"],
    "ぱ":["p","a"],"ぴ":["p","i"],"ぷ":["p","u"],"ぺ":["p","e"],"ぽ":["p","o"],
    "ま":["m","a"],"み":["m","i"],"む":["m","u"],"め":["m","e"],"も":["m","o"],
    "や":["y","a"],"ゆ":["y","u"],"よ":["y","o"],
    "ら":["r","a"],"り":["r","i"],"る":["r","u"],"れ":["r","e"],"ろ":["r","o"],
    "わ":["w","a"],"を":["","o"],"ん":["","N"],
    "ゔ":["b","u"],
    // 拗音。3つめの1は口蓋化＝子音から「い」の構えを経由して母音へ向かう印
    "きゃ":["k","a",1],"きゅ":["k","u",1],"きょ":["k","o",1],
    "ぎゃ":["g","a",1],"ぎゅ":["g","u",1],"ぎょ":["g","o",1],
    "しゃ":["S","a"],  "しゅ":["S","u"],  "しょ":["S","o"],
    "じゃ":["z","a"],  "じゅ":["z","u"],  "じょ":["z","o"],
    "ぢゃ":["z","a"],  "ぢゅ":["z","u"],  "ぢょ":["z","o"],
    "ちゃ":["c","a"],  "ちゅ":["c","u"],  "ちょ":["c","o"],
    "にゃ":["n","a",1],"にゅ":["n","u",1],"にょ":["n","o",1],
    "ひゃ":["h","a",1],"ひゅ":["h","u",1],"ひょ":["h","o",1],
    "びゃ":["b","a",1],"びゅ":["b","u",1],"びょ":["b","o",1],
    "ぴゃ":["p","a",1],"ぴゅ":["p","u",1],"ぴょ":["p","o",1],
    "みゃ":["m","a",1],"みゅ":["m","u",1],"みょ":["m","o",1],
    "りゃ":["r","a",1],"りゅ":["r","u",1],"りょ":["r","o",1],
    // 小書き母音を伴う外来音
    "ふぁ":["F","a"],"ふぃ":["F","i"],"ふぇ":["F","e"],"ふぉ":["F","o"],"ふゅ":["F","u",1],
    "うぃ":["w","i"],"うぇ":["w","e"],"うぉ":["w","o"],
    "てぃ":["t","i"],"でぃ":["d","i"],"とぅ":["t","u"],"どぅ":["d","u"],
    "つぁ":["c","a"],"つぃ":["c","i"],"つぇ":["c","e"],"つぉ":["c","o"],
    "しぇ":["S","e"],"じぇ":["z","e"],"ちぇ":["c","e"],
    "ゔぁ":["b","a"],"ゔぃ":["b","i"],"ゔぇ":["b","e"],"ゔぉ":["b","o"],
    "くぁ":["k","a"],"くぃ":["k","i"],"くぇ":["k","e"],"くぉ":["k","o"],
    // 単独で打たれた小書き母音は普通の母音として読む
    "ぁ":["","a"],"ぃ":["","i"],"ぅ":["","u"],"ぇ":["","e"],"ぉ":["","o"],
    "ゃ":["y","a"],"ゅ":["y","u"],"ょ":["y","o"],
    "ー":["","-"],"っ":["","_"],
    // 区切り。/ = 短い間（読点）、// = 長い間（句点）
    "、":["","/"],"　":["","/"]," ":["","/"],"・":["","/"],
    "。":["","//"],"！":["","//"],"？":["","//"],"!":["","//"],"?":["","//"]
  };
  // カタカナで打たれてもひらがなとして扱う。小書き文字もそのまま対応表に載っている
  function normKana(s){
    var out="";
    for(var i=0;i<s.length;i++){
      var c=s.charCodeAt(i);
      out += (c>=0x30A1 && c<=0x30F6) ? String.fromCharCode(c-0x60) : s.charAt(i);
    }
    return out;
  }
  // 1文字ずつではなくモーラ単位で切る。「きゃ」は2文字で1モーラなので先に2文字で引く
  var SMALL="ゃゅょぁぃぅぇぉ";
  function kanaList(s){
    s=normKana(s);
    var out=[], pos=[], i=0, skip=0;
    while(i<s.length){
      var two=s.substr(i,2);
      if(two.length===2 && SMALL.indexOf(two.charAt(1))>=0 && KANA[two]){ out.push(two); pos.push(i); i+=2; continue; }
      var one=s.charAt(i);
      if(KANA[one]){ out.push(one); pos.push(i); }
      else if(one.trim()!=="") skip++;
      i++;
    }
    // 読めなかった文字はここで数える。拗音は2文字で1モーラなので、
    // 文字数とモーラ数の差で数えると「じょ」まで読めない文字にされてしまう
    out.skipped=skip;
    // pos[k] は k番目のモーラが元の文字列の何文字目から始まるか。正規化は1文字を1文字に
    // 置き換えているだけなので、この位置はそのまま入力欄の中の位置として使える
    out.pos=pos;
    return out;
  }

  /* ============ プリセット ============ */
  // fs は声道の長さの倍率。1より小さいほどフォルマントが下がり、体格の大きい声になる。
  // simple:1 は声門波の傾きを掛けず、フォルマントの帯域も広く取る＝共鳴の浅い素朴な音
  // 基音は Child>Girl>Woman>Boy>Man の順。fs は声道の長さの倍率で、
  // 大きいほど短い声道＝高いフォルマント。実際の声道長は Man>Woman>Child なので
  // Boy の fs は Woman より大きくなる（ここだけは名前に合わせて入れ替えた）
  // tilt は声門波の傾きの折れ点。省略時700。低い声ほど高くすると胸に響く男声になる
  // rec は将来ドロップダウンに出すかもしれない補足。今はどこにも表示していない
  var PRESETS = [
    {id:"girl", name:"Girl",  rec:"default", f0:340, fs:1.15, mora:150, vib:14, wave:"sawtooth", blip:0.09},
    {id:"boy",  name:"Boy",   rec:"",        f0:265, fs:1.07, mora:160, vib:9,  wave:"sawtooth", blip:0.06},
    {id:"woman",name:"Woman", rec:"",        f0:285, fs:1.06, mora:205, vib:10, wave:"sawtooth", blip:0.04},
    {id:"man",  name:"Man",   rec:"",        f0:118, fs:0.80, mora:190, vib:5,  wave:"sawtooth", blip:0.03, tilt:1150},
    {id:"child",name:"Child", rec:"",        f0:430, fs:1.30, mora:125, vib:20, wave:"sawtooth", blip:0.12},
    {id:"plain",name:"Plain", rec:"simple",  f0:300, fs:1.10, mora:150, vib:6,  wave:"sawtooth", blip:0.05, simple:1},
    {id:"robot",name:"Robot", rec:"8bit",    f0:320, fs:1.18, mora:135, vib:0,  wave:"square",   blip:0.00}
  ];



  function Res(){ this.a=0; this.b=0; this.c=0; this.y1=0; this.y2=0; }
  Res.prototype.set=function(f,bw,sr){
    var r=Math.exp(-Math.PI*bw/sr), th=2*Math.PI*f/sr;
    this.c=-r*r; this.b=2*r*Math.cos(th); this.a=1-this.b-this.c;
  };
  Res.prototype.run=function(x){
    var y=this.a*x+this.b*this.y1+this.c*this.y2; this.y2=this.y1; this.y1=y; return y;
  };

  // 反共振（2零点）。鼻腔と口腔の結合で生じるスペクトルの谷。
  // 閉鎖点が奥へ行くほど残った共鳴管が短くなり零点が上がる：唇 約1100Hz / 歯茎 1450-2200Hz
  // 2零点だけの反共振は DC で正規化すると高域が数十倍になる（ナイキストで 50 倍超）。
  // 極も持つノッチ（biquad）にして、零点の周りだけ削り他はゲイン1に保つ
  function AntiRes(){ this.b0=1; this.b1=0; this.b2=0; this.a1=0; this.a2=0;
    this.x1=0; this.x2=0; this.y1=0; this.y2=0; }
  AntiRes.prototype.set=function(f,bw,sr){
    var w0=2*Math.PI*f/sr, q=Math.max(0.5, f/Math.max(30,bw));
    var al=Math.sin(w0)/(2*q), cw=Math.cos(w0), a0=1+al;
    this.b0=1/a0; this.b1=-2*cw/a0; this.b2=1/a0;
    this.a1=-2*cw/a0; this.a2=(1-al)/a0;
  };
  AntiRes.prototype.run=function(x){
    var y=this.b0*x+this.b1*this.x1+this.b2*this.x2-this.a1*this.y1-this.a2*this.y2;
    this.x2=this.x1; this.x1=x; this.y2=this.y1; this.y1=y; return y;
  };

  /* 母音のフォルマント（声色スライダーの倍率を掛けたもの） */
  function vowF(v, fs){
    var b=VOWELS[v]||VOWELS.a;
    return [b[0][0]*fs, b[1][0]*fs, b[2][0]*fs];
  }
  var FRONT={i:1,e:1};
  /* 子音の調音位置ごとの、開放直後のフォルマント [F2, F3]。
     同じ実測データ（女性8名）から、母音区間の先頭8点を直線回帰して開放時点(0%)へ外挿した中央値。
     軟口蓋音が「い」で 2764 / 「お」で 979 と大きく割れるのが velar pinch で、
     か行の聞き分けはこの差が担っている。 */
  var LOCUS={
    lab:{a:[1379,2801], i:[2615,3308], u:[1517,2744], e:[2202,2997], o:[ 937,2850]}, // 唇
    alv:{a:[1709,2981], i:[2660,3363], u:[1869,2867], e:[2256,3132], o:[1339,2882]}, // 歯茎
    vel:{a:[1549,2663], i:[2764,3677], u:[1491,2668], e:[2577,3116], o:[ 979,2698]}, // 軟口蓋
    sib:{a:[1674,3040], i:[2425,3292], u:[1809,2973], e:[2112,3022], o:[1460,3006]}, // 歯擦
    glo:{a:[1427,2967], i:[2775,3563], u:[1505,2746], e:[2408,3090], o:[ 905,2907]}  // 声門
  };
  var PLACE={ p:"lab", b:"lab", m:"lab", F:"lab",
              t:"alv", d:"alv", n:"alv",
              k:"vel", g:"vel",
              s:"sib", z:"sib", S:"sib", c:"sib",
              h:"glo" };
  function locusOf(c, v, fs){
    if(c==="y") return vowF("i",fs);
    if(c==="w") return vowF("u",fs);
    if(c==="r") return [350*fs,1400*fs,1750*fs];   // 弾き音。実測データに無いので推定値
    var pl=PLACE[c];
    if(!pl) return vowF(v,fs);
    var L=LOCUS[pl][v] || LOCUS[pl].a;
    // velar pinch: 軟口蓋音は開放の瞬間 F2 と F3 が寄り、そこから母音へ分かれる。
    // F3 が低く始まることで /w/ に似た響きが出る（「くぁ」に聞こえる正体）
    if(pl==="vel") L=[L[0], Math.max(L[0]+380, 1700)];
    // F1は閉鎖中ほぼ0で、開放と同時に立ち上がる。この挙動は測定窓（母音の中央60%）には写らないため
    // 実測値ではなく物理どおり低い値を置く。声門音(h)は閉鎖が無いので母音のF1をそのまま使う
    var f1 = (pl==="glo") ? vowF(v,fs)[0] : 250*fs;
    return [f1, L[0]*fs, L[1]*fs];
  }
  /* 破裂・摩擦の雑音。
     shape は Stevens & Blumstein による破裂音スペクトルの3分類。
       1=compact 軟口蓋音。中域に鋭い単一のピーク
       2=rising  歯茎音。広帯域で高域上がり
       3=falling 唇音。広帯域で高域下がり
     vot は開放から声が立ち上がるまでの時間。Riney, Takagi, Ota & Uchida (2007) の
     日本語語頭無声破裂音の実測 /p/30.0ms /t/28.5ms /k/56.7ms を採用。
     有声破裂は東京方言女性話者では前voicingが少なく短lag（約12ms）が優勢なためそちらに合わせた。 */
  function noiseOf(c, v, fs){
    var front=!!FRONT[v];
    switch(c){
      case "p": return {hz: 800*fs, shape:3, amp:0.016, dur:0.012, vot:0.030};
      case "b": return {hz: 360*fs, shape:3, amp:0.052, dur:0.014, vot:0.012};
      case "t": return {hz:2800*fs, shape:2, amp:0.008, dur:0.010, vot:0.028};
      case "d": return {hz:2400*fs, shape:2, amp:0.065, dur:0.012, vot:0.012};
      case "k": return {hz:(front?2900:1700)*fs, shape:1, amp:0.01, dur:0.022, vot:0.057, dbl:1};
      case "g": return {hz:(front?2500:1550)*fs, shape:1, amp:0.030, dur:0.020, vot:0.012};
      case "s": return {hz:7200, shape:2, amp:0.035, dur:0.038};
      case "S": return {hz:3400, shape:1, amp:0.0475, dur:0.052};
      case "z": return {hz:4900, shape:2, amp:0.0225, dur:0.028};
      case "c": return {hz:3500, shape:2, amp:0.0175, dur:0.024, vot:0.030};
      case "F": return {hz: 950, shape:3, amp:0.026, dur:0.062};
      case "h": return {hz:0, shape:0, amp:0.17, dur:0.065, through:true}; // は行は母音の共鳴を通す
    }
    return null;
  }
  var STOPS={p:1,b:1,t:1,d:1,k:1,g:1,c:1};
  var VOICED={b:1,d:1,g:1,z:1};
  var NASALS={n:1,m:1};

  /* かな列 → パラメータのキーフレーム列。ここで音素間を繋ぐ時刻を決める */
  // 母音別ゲイン。放射特性(+6dB/oct)が低域を削るため、F1/F2 の低い
  // う・お があ の 1/10 ほどになってしまう。実測値から逆補正する
  // 「あ」を1.00として、実測の平均音量が い0.63 う0.63 え0.79 お0.89 になる値。
  // 母音そのものの強さの差（/a/ に対して /i/ /u/ が 4dB ほど弱い）に合わせてある
  var VGAIN={a:1.00, i:3.05, u:5.72, e:3.01, o:4.02, N:4.0};
  // 語尾で音量が垂れる分を母音ごとに戻す係数。「い」だけは F1 が基音のすぐ上にあるため
  // フォルマントを一緒に動かしても取りきれず、実測でイ段だけ 15% ほど落ちていた
  var TAILUP={a:1.00, i:1.16, u:1.00, e:1.00, o:1.00, N:1.00};
  // 鼻音の厚みを母音ごとに揃える係数。
  // 実測の 鼻音/母音 比（ま23% み39% む41% め28% も23%）を 35% 前後へ寄せる
  var MGAIN={a:1.55, i:0.90, u:0.85, e:1.25, o:1.55, N:1.0};
  function buildFrames(list, P){
    var fs=P.fs, F=[], t=0, prevV=null, VG=1;
    // 歌わせるときは音ごとに基音が変わる。しゃべりでは P.f0 のまま動かない
    var curF0=P.f0;
    // ビブラートの深さ。歌では音の頭では掛けず、伸ばしてから掛ける
    var VBD0 = P.sing ? 0 : 1;
    function kf(tt,o){
      var f={t:tt, f1:800*fs, f2:1300*fs, f3:2800*fs, b1:80, b2:110, b3:170, av:0, af:0, nz:0, nhz:0, nsh:1, thru:0, vb:0, f0m:1, nzf:0, n4:0, fb:curF0, vbd:VBD0};
      for(var k in o) f[k]=o[k];
      // 母音別ゲインは口の経路にだけ掛ける。鼻腔は発音中に形が変わらないので
      // 母音によらず一定。鼻音度(nz)が高いほど補正を抜く
      var oral=1-Math.min(1, f.nz||0);
      f.av*=1+(VG-1)*oral;
      F.push(f);
    }
    for(var i=0;i<list.length;i++){
      // 要素は "か" のような文字列か、歌のときは {k:かな, hz:基音, dur:秒}
      var it=list[i], key=(typeof it==="string")?it:it.k;
      var e=KANA[key]; if(!e) continue;
      curF0 = (it && it.hz) ? it.hz : P.f0;
      var noteDur = (it && it.dur) || 0;
      var t0=t, fBase=F.length;
      // 次が長音「ー」かを先読みする。長音は前の母音がそのまま続くものなので、
      // 手前で母音を切ってしまうと音量がV字に凹み、そこが新しい音節の始まりに聞こえる
      var nextIsLong = (function(){ var nx=list[i+1]; if(nx==null) return false;
        var nk=(typeof nx==="string")?nx:nx.k; var ne=nk?KANA[nk]:null; return !!(ne && ne[1]==="-"); })();
      var c=e[0], v=e[1];
      // 休符。歌では音符の長さが渡ってくるので、そちらを優先する
      if(v==="//"){ kf(t,{av:0}); t+=(noteDur||P.mora/1000*1.7); kf(t,{av:0}); continue; }  // 句点
      if(v==="/"){ kf(t,{av:0}); t+=(noteDur||P.mora/1000*0.9); kf(t,{av:0}); continue; }   // 読点
      if(v==="_"){ kf(t,{av:0}); t+=0.075; kf(t,{av:0}); continue; }
      if(v==="-"){ if(prevV){ VG=VGAIN[prevV]||1; var Vp=vowF(prevV,fs);
        kf(t,{f1:Vp[0],f2:Vp[1],f3:Vp[2],av:0.90});
        // 切る時間は音符の枠の外に足さず、枠の中から取る。
        // 外に足すと「ー」1個につき遅れが積もり、時刻は加算式なので後続すべてがずれていく
        // （「ー」9個の歌で実測0.378秒の遅れになっていた）
        //
        // 切る時間を 0.042→0.070 にした。伸ばす音には子音が無いので枠の頭から鳴り始める。
        // 普通の音符は子音の閉鎖で頭に約68msの無音ができるぶん短く鳴るので、同じだけ枠を
        // 使うと伸ばした音だけ長く聞こえていた（実測：2列の伸ばしが512ms鳴るのに対し、
        // 普通の音符2つぶんは456ms）。末尾を約50ms早く切って釣り合わせる
        t += (noteDur>0) ? Math.max(0.02, noteDur-(nextIsLong?0:0.070)) : (P.mora/1000);
        kf(t,{f1:Vp[0],f2:Vp[1],f3:Vp[2],av:0.82});
        // 長音が続くなら切らずに渡す。終わりなら切る（切らないとぶつ切りで終わる）
        // 落とす傾きは普通の音符の語尾（0.030秒）に合わせる
        if(!nextIsLong){ t+=0.030; kf(t,{f1:Vp[0],f2:Vp[1],f3:Vp[2],av:0}); t+=0.040; }
      } continue; }
      var V = (v==="N") ? [260*fs,1200*fs,2400*fs] : vowF(v,fs);
      VG = VGAIN[v] || 1;
      var pal = !!e[2];                       // 拗音
      // 拗音は子音の後に /i/ の渡りが入るぶん破裂が埋もれる。
      // 素の音と同じ強さだと「きゃ」が「や」に聞こえる
      var pbg = pal ? 3.4 : 1;
      // 口蓋化した子音は「い」の位置で開放される。locusも母音側も「い」を経由させる
      var L = locusOf(c, pal ? "i" : (v==="N"?"a":v), fs);
      var PI = vowF("i", fs);
      // 拗音のときだけ、子音から母音へ向かう途中に「い」の構えを1枚挟む
      function glideTo(tt){ if(!pal) return tt; kf(tt,{f1:PI[0],f2:PI[1],f3:PI[2], av:0.92}); return tt+0.022; }
      var nsp = noiseOf(c, v==="N"?"a":v, fs);
      var vd = Math.max(0.05, P.mora/1000);
      var nasal = !!NASALS[c] || v==="N";
      // 鼻音の共鳴。唇/舌で閉じた奥の空洞が鳴るため F2 が低く、母音より「お」寄りに聞こえる
      // 鼻音中の口の共鳴。聞こえ方としては ま行が「んも」、な行が「んぬ」になる
      var NL = (c==="m") ? [285*fs, 950*fs,2100*fs] : [400*fs,1500*fs,2400*fs];
      // 反共振。ま行は現状の響きを変えないため入れない（0 = 無効）
      var NZF = (c==="n") ? 1800*fs : ((v==="N") ? 2200*fs : 0);
      // 零点は「そこにあるエネルギーを削る」ものなので、削る対象が無いと効かない。
      // な行は N2(約1000Hz)が立つのが特徴なので減衰を緩める。ま行は現状のまま
      var NB2 = (c==="n"||v==="N") ? 260 : 600;

      if(STOPS[c]){
        // 閉鎖。有声破裂は閉鎖中も声帯が鳴り続ける（voice bar）ので低い唸りが残る
        var vb = VOICED[c] ? 0.55 : 0;
        var clo = VOICED[c] ? 0.050 : 0.062;
        // 唸るのは閉鎖の最後の1/4だけ。閉鎖の頭から鳴らし続けると持続音に聞こえてしまう
        var barT = clo*0.25, ramp = Math.min(0.003, barT*0.3);
        // 有声破裂は閉鎖の後半で軟口蓋が下がり、息が鼻へ抜ける（前鼻音化）。
        // これが「んば」「んだ」「んが」の「ん」で、破裂の立ち上がりを柔らかくする
        var nzv = VOICED[c] ? 1.2 : 0, nav = VOICED[c] ? 0.42 : 0;
        kf(t,{av:0, af:0, vb:0, nz:0, f1:180*fs, f2:L[1], f3:L[2], b1:90});
        t += clo*0.30;
        kf(t,{av:0, af:0, vb:0, nz:0, f1:180*fs, f2:L[1], f3:L[2], b1:90});
        t += 0.004;
        kf(t,{av:nav, af:0, vb:0, nz:nzv, f0m:0.31, f1:270*fs, f2:L[1], f3:L[2], b1:320, b2:600, b3:800});
        t += clo*0.70 - barT - 0.004;
        kf(t,{av:nav, af:0, vb:0, nz:nzv, f0m:0.31, f1:270*fs, f2:L[1], f3:L[2], b1:320, b2:600, b3:800});
        t += ramp;
        kf(t,{av:nav, af:0, vb:vb, nz:nzv, f0m:0.31, f1:270*fs, f2:L[1], f3:L[2], b1:320, b2:600, b3:800});
        t += barT - ramp - 0.0015;
        kf(t,{av:nav, af:0, vb:vb, nz:nzv, f0m:0.31, f1:270*fs, f2:L[1], f3:L[2], b1:320, b2:600, b3:800});
        // 閉鎖から開放へは 1.5ms かけて渡す。同じ時刻に2枚置くと、前鼻音(nz)・音量・
        // 基音・F1 が 1サンプルで飛び、そこだけ波形が階段状に跳ねて「プチッ」と鳴る
        // （有声破裂の「で」で実測 0.40 の段差。破裂音としての鋭さはこの長さでは失われない）
        t += 0.0015;
        // 開放バースト。閉鎖の無音から一瞬で最大にすると段差が「コツン」という打撃音になるので、
        // 2.5msだけ立ち上がりを付ける（破裂らしさは保ったままクリックが消える）
        kf(t,{f1:L[0],f2:L[1],f3:L[2], av:(VOICED[c]?0.42:0), af:0, vb:vb*0.35, f0m:(VOICED[c]?0.70:1), nhz:nsp.hz, nsh:nsp.shape, b1:(VOICED[c]?170:220)});
        t+=0.004;
        if(nsp.dbl){
          // 軟口蓋音の二重バースト。舌の一部が先に離れて弱い破裂が起き、
          // 少し遅れて残りが離れて主破裂が来る。単発だと「コツン」という打撃音になる
          kf(t,{f1:L[0],f2:L[1],f3:L[2], av:(VOICED[c]?0.45:0), af:nsp.amp*pbg*0.38, f0m:(VOICED[c]?0.73:1.02), nhz:nsp.hz, nsh:nsp.shape, b1:(VOICED[c]?160:220)});
          t+=0.007;
          kf(t,{f1:L[0],f2:L[1],f3:L[2], av:(VOICED[c]?0.45:0), af:nsp.amp*pbg*0.12, f0m:(VOICED[c]?0.75:1.03), nhz:nsp.hz, nsh:nsp.shape, b1:(VOICED[c]?160:220)});
          t+=0.005;
        }
        kf(t,{f1:L[0],f2:L[1],f3:L[2], av:(VOICED[c]?0.48:0), af:nsp.amp*pbg, vb:vb*0.2, f0m:(VOICED[c]?0.76:1.04), nhz:nsp.hz, nsh:nsp.shape, b1:(VOICED[c]?150:220)});
        t+=nsp.dur;
        // 気音。VOTの残りぶん、声が出ないまま雑音だけが声道を通る（＝後続母音の色がつく）
        var asp = Math.max(0.004, (nsp.vot||0.020) - nsp.dur);
        // 気音の間、F1は閉鎖位置から母音へ向けて既に上がり始めていて、かつ強く減衰している
        kf(t,{f1:(L[0]+V[0])/2, f2:L[1], f3:L[2], av:(VOICED[c]?0.66:0), af:VOICED[c]?0.013:0.048, thru:1, f0m:(VOICED[c]?0.83:1.06), b1:(VOICED[c]?125:300)});
        t+=asp;
        kf(t,{f1:L[0],f2:L[1],f3:L[2], av:(VOICED[c]?0.80:0.68), af:0, b1:(VOICED[c]?110:140), f0m:(VOICED[c]?0.90:1.08)});                          // 声の立ち上がり
        t+=(VOICED[c]?0.030:0.044); t=glideTo(t);
        kf(t,{f1:V[0],f2:V[1],f3:V[2], av:1, af:0});                                    // ← 遷移の到達点
      } else if(nsp){
        var thru = nsp.through?1:0;
        // 摩擦は無音から一瞬で最大にすると頭に「ザッ」という段差が出る。8ms かけて立ち上げる
        kf(t,{f1:(thru?V[0]:L[0]),f2:(thru?V[1]:L[1]),f3:(thru?V[2]:L[2]), av:VOICED[c]?0.25:0, af:0, nhz:nsp.hz, nsh:nsp.shape, thru:thru, b1:thru?110:200});
        t+=0.008;
        kf(t,{f1:(thru?V[0]:L[0]),f2:(thru?V[1]:L[1]),f3:(thru?V[2]:L[2]), av:VOICED[c]?0.25:0, af:nsp.amp*pbg, nhz:nsp.hz, nsh:nsp.shape, thru:thru, b1:thru?110:200});
        t+=nsp.dur*0.82;
        // 摩擦の間は声を出さない。ここで av を 0 のまま保たないと、/s/ の最中に
        // 母音が混ざって低域が濁り、擦れた音が鈍る
        kf(t,{f1:(thru?V[0]:L[0]),f2:(thru?V[1]:L[1]),f3:(thru?V[2]:L[2]), av:VOICED[c]?0.25:0, af:nsp.amp*pbg*0.92, nhz:nsp.hz, nsh:nsp.shape, thru:thru, b1:thru?110:200});
        t+=nsp.dur*0.18;
        kf(t,{f1:L[0],f2:L[1],f3:L[2], av:0.62, af:nsp.amp*0.06, nhz:nsp.hz, nsh:nsp.shape, thru:thru});
        t+=0.040; t=glideTo(t);
        kf(t,{f1:V[0],f2:V[1],f3:V[2], av:1, af:0});
      } else if(nasal && c){
        // 閉じた口腔が側枝となって零点を作る。閉鎖点が奥へ行くほど管が短くなり零点が上がる
        var NZ = (c==="m") ? 1000*fs : ((v==="N") ? 3200*fs : 1700*fs);
        // 開放時のフォルマント。唇は F2 が低く（上昇して母音へ）、歯茎は高い（下降して母音へ）。
        // 「場所の判別は遷移情報が最も重要」とされる部分なので、ここを明確に分ける
        var RL = (c==="m") ? [L[0], 850*fs, 2250*fs] : [L[0], 1800*fs, 2650*fs];
        // N4（約2400Hz・帯域150Hz の鋭い極）が な行 らしさの正体だが、鋭いぶん
        // 265Hz の声で鳴らすと「ビリビリ」という金属的な唸りになる。
        // に・ぬ・の はここを 6割に落とす（値そのものが強さの倍率になる）
        // 「に」は「の」の形式との中間に置く（圧が強くブザーっぽくなるため）
        var NN4={a:1.00, i:0.80, u:0.60, e:1.00, o:0.60};
        var N4 = (c==="m") ? 0 : (NN4[v]||1);
        // な行の鼻音だけ基音を1オクターブ下げる。
        // 母音に向けて段階的に戻す（一気に戻すと別の声に聞こえる）
        // 「な」の子音部は隣の母音の設定を借りる。murmur はその色のままで、
        // 母音だけが目標へ向かう（「んぬあ」）。「に」にも同じ仕組みを入れ、
        // 子音部は「ぬ」の色を借りて「んぬい」と渡す
        var cv = (c==="n") ? ({a:"i", i:"u"}[v] || v) : v;
        var isNA = false;
        var NF0 = (c==="n") ? 0.78 : 1;
        // な行の子音を母音ごとに微調整する。に・ぬ・の は鼻音が強く長く出すぎて
        // ビリビリと震えて聞こえるので、弱く（NAMP）かつ短く（NDUR）する。
        // な・ね はこのままでよいので 1.00 のまま
        // 「に」の 0.77 は、鼻音の実効の強さが「の」の 0.403 と現状 0.744 の
        // ちょうど中間（0.574）になる値。長さ・N4 も「の」との中間にしてある
        var NAMP={a:1.00, i:0.77, u:0.50, e:1.00, o:0.52};
        var NDUR={a:1.00, i:0.81, u:0.62, e:1.00, o:0.62};
        var nd = (c==="n") ? (NDUR[v]||1) : 1;
        var mg = (MGAIN[cv]||1) * (c==="n" ? 0.5*(NAMP[v]||1) : 1);
        // 「な」「に」は借りた色のぶん鼻音が弱くなるので、その分を強める
        if(c==="n" && (v==="a"||v==="i")) mg *= 1.75;
        // 鼻音を静止させるとブザーが鳴っているだけになり、母音から浮く。
        // 基音もフォルマントも「ん」から母音へ向けて連続的に上げていく。
        // 「んぬあ」のように途中の色を経由させるのが狙い
        function LERP(a,b,x){ return a+(b-a)*x; }
        function NKF(tt,k,avv,nzz){
          kf(tt,{ av:avv, nz:nzz, nzf:NZ, n4:N4,
                  f0m: LERP(NF0, 1, k*k),
                  f1: LERP(NL[0], V[0], k*0.85),
                  f2: LERP(NL[1], RL[1], k),
                  f3: LERP(NL[2], RL[2], k),
                  b1: LERP(300,150,k), b2: LERP(400,130,k), b3: LERP(500,200,k) });
        }
        // 鼻音の音量の推移。な行は入りを弱く、中盤から後半へ向けて強くする
        var AE = (c==="n") ? [0.18,0.34,0.58,0.85,1.10] : [0.32,0.90,0.92,0.95,1.00];
        NKF(t, 0.00, AE[0]*mg, 1.00);  t+=0.010*nd;
        NKF(t, 0.06, AE[1]*mg, 1.00);  t+=(c==="n"?0.026:0.020)*nd;
        NKF(t, 0.26, AE[2]*mg, 0.96);  t+=(c==="n"?0.026:0.020)*nd;
        NKF(t, 0.52, AE[3]*mg, 0.86);  t+=0.016*nd;
        NKF(t, 0.74, AE[4]*mg, 0.62);  t+=0.010*nd;
        // 開放。鼻腔から口へ移るが、この時点で既に基音もフォルマントも母音寄り
        // 母音への繋ぎ。「な」は中間点を増やして長めに渡す
        NKF(t, 0.84, 1.00, 0.44);     t+=(isNA?0.016:0.006)*nd;
        NKF(t, 0.92, 1.00, 0.26);     t+=(isNA?0.022:0.018)*nd;
        NKF(t, 0.97, 1.00, 0.12);
        // 「んぬあ」の「ぬ」を実音として通す。
        // 鼻性はもう抜けているので、口の「う」のフォルマントを短く経由させる
        t+=(isNA?0.034:0.026)*nd; t=glideTo(t);
        kf(t,{f1:V[0],f2:V[1],f3:V[2], av:1, nz:(v==="N")?1:0, nzf:(v==="N")?NZ:0});
        t+=0.004;
      } else if(c==="r"){
        kf(t,{f1:L[0],f2:L[1],f3:L[2], av:0.45, b1:200}); t+=0.026;                     // 弾き音
        kf(t,{f1:L[0],f2:L[1],f3:L[2], av:0.9});
        t+=0.032; t=glideTo(t); kf(t,{f1:V[0],f2:V[1],f3:V[2], av:1});
      } else if(c==="y"||c==="w"){
        kf(t,{f1:L[0],f2:L[1],f3:L[2], av:0.85}); t+=0.055;                             // 半母音は滑らかに
        kf(t,{f1:V[0],f2:V[1],f3:V[2], av:1});
      } else {
        kf(t,{f1:V[0],f2:V[1],f3:V[2], av:0.04}); t+=0.030;                             // 母音単独
        kf(t,{f1:V[0],f2:V[1],f3:V[2], av:1, nz:(v==="N")?1:0});
      }
      // 母音は頭を頂点に、切るまでに 8割まで緩やかに落とす。
      // 全開のまま止めると全部の音が押し出すように聞こえて「圧」になり、
      // 逆に早くから落とすと歯切れが悪く言い切っていない印象になる。
      // 大事なのは減衰の量より、行によってばらつかないこと。
      // 語尾の f0 はわずかに上げる。ただし f0 だけを上げると、フォルマントに乗って
      // いた倍音がフォルマントから外れ、実測で 3〜4 割も音量が落ちてしまう。しかも
      // 子音のぶん母音が後ろへずれるカナほど落ち方が変わるので、行によって語尾の
      // 歯切れがばらついていた。フォルマントも同じ比率で上げて倍音の位置関係を保つ
      // （声が高くなると声道が短くなるのと同じことなので、音色としても自然）
      var TS=function(x){ return [V[0]*x, V[1]*x, V[2]*x]; }, TV, TU=TAILUP[v]||1;
      // 歌では、音符の長さから子音に使ったぶんを引いた残りが母音の長さになる。
      // しゃべりの語尾の減衰・上昇も入れない（歌は伸ばした高さを保つ）
      var SG=!!P.sing;
      // 歌では音符の長さが決まっている。子音が長すぎると母音が下限(0.05秒)に貼り付き、
      // その音節が枠をはみ出す。時刻は加算式なので、はみ出しは以降の全部を後ろへずらし、
      // 一度ずれたら戻らない（実測で1曲38秒に対し0.43秒の遅れになっていた）。
      // 母音を潰す代わりに、いま積んだ子音のキーフレームを時間方向に縮めて枠へ収める。
      // 歌は拍に乗るものなので、はみ出すくらいなら子音を詰める方が正しい
      if(noteDur>0){
        var consT=t-t0, tailNeed=(nextIsLong?0.066:0.100);
        var maxCons=Math.max(0.02, noteDur-tailNeed);
        if(consT>maxCons && consT>1e-6){
          var kk=maxCons/consT;
          for(var q=fBase;q<F.length;q++) F[q].t = t0 + (F[q].t-t0)*kk;
          t = t0 + maxCons;
        }
      }
      if(noteDur>0) vd = Math.max(0.05, (noteDur-(t-t0)-(nextIsLong?0:0.034))/0.92);
      var TA=SG?1.00:0.92, TB=SG?1.00:0.80, FA=SG?1:1.01, FB=SG?1:1.04, FC=SG?1:1.06;
      if(nextIsLong){
        // 次が長音。減衰も語尾の上昇も入れず、長音の入り(0.90)と同じ高さで渡して繋げる
        t+=vd*0.62;
        kf(t,{f1:V[0],f2:V[1],f3:V[2], av:0.97, vbd:VBD0, nz:(v==="N")?1:0});
        t+=vd*0.30;
        kf(t,{f1:V[0],f2:V[1],f3:V[2], av:0.90, vbd:1, nz:(v==="N")?1:0});
      } else {
      t+=vd*0.62; TV=TS(FA);
      kf(t,{f1:TV[0],f2:TV[1],f3:TV[2], av:TA, f0m:FA, vbd:VBD0, nz:(v==="N")?1:0});
      t+=vd*0.30; TV=TS(FB);
      kf(t,{f1:TV[0],f2:TV[1],f3:TV[2], av:TB*TU, f0m:FB, vbd:1, nz:(v==="N")?1:0});    // 母音の保持
      t+=(SG?0.030:0.022); TV=TS(FC);
      kf(t,{f1:TV[0],f2:TV[1],f3:TV[2], av:0, f0m:FC, vbd:1});                          // 短く切る
      t+=(SG?0.004:0.020);
      }
      if(v!=="N") prevV=v;
    }
    return {frames:F, dur:t+0.05};
  }

  /* キーフレームを補間しながら1サンプルずつ合成する */
  function renderFormant(ctx, list, P){
    var c=ctx, sr=c.sampleRate;
    var built=buildFrames(list,P), F=built.frames;
    if(!F.length) return null;
    var n=Math.max(1, Math.ceil(built.dur*sr));
    var buf=c.createBuffer(1,n,sr), out=buf.getChannelData(0);
    var r1=new Res(), r2=new Res(), r3=new Res(), r4=new Res();
    var rn=new Res(), rf=new Res(), rz=new AntiRes();
    // 鼻腔は発音中に形が変わらない固定の共鳴器。N1 250-300 / N2 1000-1300 / N4 約2000Hz。
    // 損失が大きいため帯域幅は広い。口のフォルマント縦続とは別経路にする
    var rnA=new Res(), rnB=new Res(), rnC=new Res();
    // 最低次の極を広げて低域の突出を抑え、N2 を鋭くして形をはっきりさせる
    rnA.set(275*P.fs,230,sr); rnB.set(1060*P.fs,170,sr);
    var nlp=0, NLPA=1-Math.exp(-2*Math.PI*Math.min(sr*0.30,3500)/sr);   // 3.5kHz以上はほぼ出ない
    rn.set(280*P.fs,185,sr); r4.set(3600*P.fs,250,sr);
    var phase=0, prevOut=0, k=0;
    var lpS=0, lpS2=0, hpS=0, hpS2=0, hpS3=0, hpL=0, hpL2=0;
    var nb1=0, nb2=0, nb3=0, nb4=0, murPh=0;
    var NBA=1-Math.exp(-2*Math.PI*Math.min(sr*0.26, 12000)/sr);   // 破裂音・摩擦音スペクトル用の1次フィルタ状態
    var vib=P.vib/1000, sq=(P.wave==="square");
    // 声門波の傾き。鋸波は -6dB/oct、放射特性が +6dB/oct なので差し引き平らになり、
    // 中高域が出すぎて「圧の強い」押し出すような声になる。実際の声門流は -12dB/oct
    // なので、1次のローパスを1段かけて -6dB/oct を足し、放射と合わせて -6dB/oct にする
    // simpleの声は傾きを掛けない（明るくざらつく）。フォルマントの帯域も広げて共鳴を浅くする
    // tilt は声門波の傾きの折れ点(Hz)。高くするほど低次倍音が残って胸に響く太い声、
    // 低くすると柔らかく息っぽい声。既定 700。大人男性だけ高めにして女声と離す
    var glp=0, GLPA=P.simple ? 1 : (1-Math.exp(-2*Math.PI*(P.tilt||700)/sr));
    var BWX=P.simple ? 2.2 : 1;
    // 帯域制限した鋸波／矩形波（PolyBLEP）。素の鋸波はエイリアスでざらつく
    function blep(tp,dt){
      if(tp<dt){ tp/=dt; return tp+tp-tp*tp-1; }
      if(tp>1-dt){ tp=(tp-1)/dt; return tp*tp+tp+tp+1; }
      return 0;
    }
    for(var i=0;i<n;i++){
      var tt=i/sr;
      while(k<F.length-2 && tt>=F[k+1].t) k++;
      var A=F[k], B=F[k+1]||F[k];
      var span=Math.max(1e-6,B.t-A.t), u=Math.min(1,Math.max(0,(tt-A.t)/span));
      var f1=A.f1+(B.f1-A.f1)*u, f2=A.f2+(B.f2-A.f2)*u, f3=A.f3+(B.f3-A.f3)*u;
      var b1=A.b1+(B.b1-A.b1)*u, b2=A.b2+(B.b2-A.b2)*u, b3=A.b3+(B.b3-A.b3)*u;
      var av=A.av+(B.av-A.av)*u, af=A.af+(B.af-A.af)*u, nz=A.nz+(B.nz-A.nz)*u;
      var vbar=A.vb+(B.vb-A.vb)*u, f0m=A.f0m+(B.f0m-A.f0m)*u;
      // 基音はキーフレームが持つ。音符の変わり目だけで動くので、音の中では揺れない
      var fbase=A.fb+(B.fb-A.fb)*u, vbd=A.vbd+(B.vbd-A.vbd)*u;
      var nhz=A.nhz+(B.nhz-A.nhz)*u, thru=A.thru+(B.thru-A.thru)*u, nsh=A.nsh;
      var nzf=A.nzf||B.nzf;
      var n4=A.n4||B.n4;   // 補間しない（途中の低い値でノッチが暴れるため）   // 形状は補間せず左のフレームを使う

      /* 声門音源：帯域制限した鋸波。声門流そのものに相当するので放射の微分は掛けない */
      var bl=(P.blip>0?P.blip*Math.exp(-tt*14):0);   // 発声の頭で基音が跳ね上がる分
      var vbr=(vib>0? vib*vbd*Math.sin(2*Math.PI*5.6*tt) : 0);
      var PS=(1+bl)*(1+vbr);                         // 基音がいま基準から何倍ずれているか
      var f0=fbase*f0m*PS;
      var dt=f0/sr;
      phase+=dt; if(phase>=1) phase-=1;
      var wave;
      if(sq){ wave=(phase<0.5?1:-1) + blep(phase,dt) - blep((phase+0.5)%1,dt); }
      else  { wave=2*phase-1 - blep(phase,dt); }
      glp += (wave*av*0.55 - glp)*GLPA;
      var src=glp;

      /* 雑音源。破裂音のスペクトル形状を3種類で作り分ける */
      // 雑音のフィルタは常に回す。af=0 の間だけ止めると状態が凍り、次の子音で過渡音が出る
      var raw=Math.random()*2-1;
      nb1+=(raw-nb1)*NBA; nb2+=(nb1-nb2)*NBA; nb3+=(nb2-nb3)*NBA; nb4+=(nb3-nb4)*NBA;
      var wn=nb4*3.1;
      // 整形フィルタも常時回す。af=0 の間に状態が凍ると、次の子音の頭で段差が出る
      if(af<=0.0005){
        var hz0=nhz||3000;
        var ah0=1-Math.exp(-2*Math.PI*Math.max(200,hz0)/sr);
        var at0=1-Math.exp(-2*Math.PI*Math.min(sr*0.30, hz0*1.25)/sr);
        hpS+=(wn-hpS)*ah0; var z1=wn-hpS; hpS2+=(z1-hpS2)*ah0; var z2=z1-hpS2;
        hpS3+=(z2-hpS3)*ah0; z2=z2-hpS3; hpL+=(z2-hpL)*at0; hpL2+=(hpL-hpL2)*at0;
        lpS+=(wn-lpS)*ah0; lpS2+=(lpS-lpS2)*ah0;
      }
      var noise=0;
      if(af>0.0005){
        if(thru>0.001){ src+=wn*af*0.16*thru; }                       // 声道を通す（は行・気音）
        if(thru>0.999){ /* 完全に声道経由 */ }
        else if(nsh===2){                                             // 高域上がり（歯茎音・s）
          // 高域を通したうえで最上部も落とす。白色雑音のまま上まで伸ばすと
          // 24kHzまでの成分が残って「ザラザラ」した硬い音になるため
          // 上下とも2次(-12dB/oct)で挟んで帯域を絞る。1次だと裾が広がって
          // 低域と最上部が残り、/s/ が「ザラザラ」した白色雑音に聞こえる
          var ah=1-Math.exp(-2*Math.PI*Math.max(200,nhz)/sr);
          hpS+=(wn-hpS)*ah;  var h1=wn-hpS;
          hpS2+=(h1-hpS2)*ah; var h2=h1-hpS2;
          hpS3+=(h2-hpS3)*ah; h2=h2-hpS3;   // 3次(-18dB/oct)。低域が残ると濁って聞こえる
          var at=1-Math.exp(-2*Math.PI*Math.min(sr*0.30, nhz*1.25)/sr);
          hpL+=(h2-hpL)*at; hpL2+=(hpL-hpL2)*at; noise=hpL2*af*4.2*(1-thru);
        } else if(nsh===3){                                           // 高域下がり（唇音・ふ）
          // 1次(-6dB/oct)では下がりきらないので2段にして -12dB/oct にする。
          // これが足りないと「ば」の破裂が高く硬く聞こえる
          var al=1-Math.exp(-2*Math.PI*Math.max(200,nhz)/sr);
          lpS+=(wn-lpS)*al; lpS2+=(lpS-lpS2)*al; noise=lpS2*af*1.9*(1-thru);
        } else {                                                      // 中域に鋭いピーク（軟口蓋音・し）
          rf.set(Math.max(180,nhz), Math.max(150,nhz/2.6), sr);
          noise=rf.run(wn)*af*0.26*(1-thru);
        }
      }
      /* 声道：カスケード共振器。鼻音は低い共鳴を並列に足す */
      // 基音が動くと倍音がフォルマントの上を滑り、音量が大きく上下してしまう。
      // 頭の跳ね上がり(blip)では「い」が 0.82→0.48 と4割落ち、「あ」は逆に最後まで
      // 上がり続けていた。ビブラートも同じ理由で母音ごとに違う波打ちを作っていた。
      // フォルマントを基音と同じ比率で動かせば倍音との位置関係が保たれ、音量の形は
      // av の指定どおりになって全部の行で揃う（声が高くなると声道が短くなるのと同じ）
      // F4 も一緒に動かす。「い」は F3 と F4 が隣り合っているので、F4 だけ固定だと
      // そこだけ倍音の乗り方が変わり、「い」の行にだけ音量の波打ちが残ってしまう
      r1.set(Math.max(120,f1*PS), b1*BWX, sr); r2.set(Math.max(200,f2*PS), b2*BWX, sr); r3.set(Math.max(400,f3*PS), b3*BWX, sr);
      r4.set(3600*P.fs*PS, 250, sr);
      // 反共振。零点の位置が「どこで口を閉じているか」を伝える。
      // 唇(ま行)と歯茎(な行)はここが違うだけで聞き分けられる
      var yOral=r4.run(r3.run(r2.run(r1.run(src))));
      // 鼻音の経路。口を閉じているので口のフォルマントは使わない。
      // 鼻腔の極を縦続し、閉じた口腔（側枝）が作る零点を掛け、最後に 3.5kHz で落とす
      // 第3の鼻腔極。[m] は広く弱く、[n] は高く鋭くする。
      // 文献にいう「[n] は N4 約2000Hz が見える第2のフォルマントになる」を作る
      // N4 を縦続の3段目に置くと、前段で高域が落ち切ってから鳴るので山にならない。
      // 並列に出して音源を直接受ける。[n] はこの N4 が第2のフォルマントに見える
      var nsig=rnB.run(rnA.run(src));
      rnC.set((n4>0.5?2400:1850)*P.fs, (n4>0.5?150:420), sr);
      var n4sig=rnC.run(src);
      nsig += n4sig*(n4>0.5?0.13*n4:0.035);   // n4 の値そのものが N4 の強さの倍率
      if(nzf>200){ rz.set(nzf, 420, sr); nsig=rz.run(nsig); } else { rz.run(nsig); }
      nlp+=(nsig-nlp)*NLPA;
      var y=yOral;
      // 閉じた口腔は零点を作るだけでなく、側枝として共鳴もする。
      // 完全に鼻腔だけにするとブザーのような響きになるので、口の響きを残す
      var nzAmt=nz>1?1:(nz<0?0:nz);
      if(nzAmt>0.70) nzAmt=0.70;
      if(nzAmt>0.001) y=yOral*(1-nzAmt)+nlp*2.7*nzAmt;
      // 放射特性（口から出るときの +6dB/oct）。鋸波の -6dB/oct を打ち消して
      // フォルマントが基音に埋もれないようにする。これが無いと母音が区別できない。
      // バースト雑音はここを通すと高域が持ち上がって形状が崩れるので、放射の後に足す
      var rad=y-0.97*prevOut; prevOut=y;
      var mur=0;
      if(vbar>0.001){ murPh+=f0/sr; if(murPh>=1) murPh-=1;   // 基音の3オクターブ下で唸らせる
        var mph=2*Math.PI*murPh;
        // 声帯そのものの振動なので純音ではない。倍音を重ねて唸りを出し、
        // ゆっくりした揺れを掛けて「ぶるぶる」という震えを作る
        // 声帯の振動は基音の周期そのもの。1周期の頭に力が集中したパルス状の波形にすると
        // 低い唸りにざらつきが出る。ゆっくりした振幅変調を掛けると宇宙人の声になるので使わない
        var pulse=Math.exp(-murPh*7.5)*2.2-0.42;
        // 2倍音を足しすぎると基音より前に出てしまい、下げたはずの唸りが高く聞こえる
        var buzz=pulse+0.10*Math.sin(2*mph);
        mur=buzz*vbar*0.055; }   // 有声閉鎖のvoice bar
      out[i]=rad+noise+mur;
    }
    // 全体を一定の音量へ正規化する（母音と破裂音の相対バランスは保ったまま）
    var pk=0;
    for(var j=0;j<n;j++){ var a2=out[j]<0?-out[j]:out[j]; if(a2>pk) pk=a2; }
    // 出力レベル。簡易版より 18dB も大きく、それ自体が「圧」になっていたので下げる
    var g=pk>1e-6 ? 0.50/pk : 0;
    for(var m=0;m<n;m++){ var fade=Math.min(1, m/300, (n-m)/600); out[m]=out[m]*g*fade; }
    return buf;
  }

  /* ---- 外部インタフェース ---- */
  // かな文字列 → モーラの配列。読めない文字は out.skipped に数える
  function moraList(text){ return kanaList(text||""); }
  // かな列(または{k,hz,dur}の配列)を AudioBuffer にする。ctx は AudioContext
  function render(ctx, list, P){ return renderFormant(ctx, list, P); }

  // 声色プリセット。id を Voice ノードの voicePreset に保存する
  // 知らないIDは女子(girl)に倒す。旧IDのpop/chibi/soft/low/chipを持つ保存データもここで拾う
  function preset(id){ for(var i=0;i<PRESETS.length;i++) if(PRESETS[i].id===id) return PRESETS[i];
    for(var j=0;j<PRESETS.length;j++) if(PRESETS[j].id==="girl") return PRESETS[j];
    return PRESETS[0]; }
  function params(id){ return Object.assign({}, preset(id)); }

  global.VoiceSynth = { moraList:moraList, render:render, KANA:KANA,
                        PRESETS:PRESETS, preset:preset, params:params };
})(window);
