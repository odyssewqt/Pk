// 扑克核心：牌堆构建、洗牌、牌型评估、比牌
export const SUITS = [
  { key: 's', symbol: '♠', name: '黑桃', color: 'text-slate-900' },
  { key: 'h', symbol: '♥', name: '红桃', color: 'text-rose-600' },
  { key: 'd', symbol: '♦', name: '方块', color: 'text-rose-600' },
  { key: 'c', symbol: '♣', name: '梅花', color: 'text-slate-900' }
];

export const RANKS = [
  { v: 2, label: '2' }, { v: 3, label: '3' }, { v: 4, label: '4' }, { v: 5, label: '5' },
  { v: 6, label: '6' }, { v: 7, label: '7' }, { v: 8, label: '8' }, { v: 9, label: '9' },
  { v: 10, label: '10' }, { v: 11, label: 'J' }, { v: 12, label: 'Q' }, { v: 13, label: 'K' }, { v: 14, label: 'A' }
];

export const HAND_NAMES = {
  9: '皇家同花顺',
  8: '同花顺',
  7: '四条',
  6: '葫芦',
  5: '同花',
  4: '顺子',
  3: '三条',
  2: '两对',
  1: '一对',
  0: '高牌'
};

export function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit: suit.key, symbol: suit.symbol, color: suit.color, value: rank.v, label: rank.label, id: rank.label + suit.key });
    }
  }
  return deck;
}

export function shuffle(deck) {
  const arr = deck.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 评估恰好 5 张牌
function evaluateFive(cards) {
  const values = cards.map(c => c.value).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  // 按 数量优先、点数次之 排序
  const groups = Object.keys(counts)
    .map(k => ({ value: Number(k), count: counts[k] }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  const uniqueDesc = groups.map(g => g.value).slice().sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniqueDesc.length === 5) {
    if (uniqueDesc[0] - uniqueDesc[4] === 4) straightHigh = uniqueDesc[0];
    else if (uniqueDesc[0] === 14 && uniqueDesc[1] === 5 && uniqueDesc[4] === 2) straightHigh = 5; // A2345
  }

  if (isFlush && straightHigh) {
    const cat = straightHigh === 14 ? 9 : 8;
    return { category: cat, tiebreak: [straightHigh], cards };
  }
  if (groups[0].count === 4) {
    return { category: 7, tiebreak: [groups[0].value, groups[1].value], cards };
  }
  if (groups[0].count === 3 && groups[1] && groups[1].count === 2) {
    return { category: 6, tiebreak: [groups[0].value, groups[1].value], cards };
  }
  if (isFlush) {
    return { category: 5, tiebreak: uniqueDesc, cards };
  }
  if (straightHigh) {
    return { category: 4, tiebreak: [straightHigh], cards };
  }
  if (groups[0].count === 3) {
    const kickers = groups.slice(1).map(g => g.value).sort((a, b) => b - a);
    return { category: 3, tiebreak: [groups[0].value, ...kickers], cards };
  }
  if (groups[0].count === 2 && groups[1] && groups[1].count === 2) {
    const pairs = [groups[0].value, groups[1].value].sort((a, b) => b - a);
    return { category: 2, tiebreak: [...pairs, groups[2].value], cards };
  }
  if (groups[0].count === 2) {
    const kickers = groups.slice(1).map(g => g.value).sort((a, b) => b - a);
    return { category: 1, tiebreak: [groups[0].value, ...kickers], cards };
  }
  return { category: 0, tiebreak: uniqueDesc, cards };
}

function combinations(arr, k) {
  const res = [];
  const combo = [];
  function walk(start) {
    if (combo.length === k) { res.push(combo.slice()); return; }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      walk(i + 1);
      combo.pop();
    }
  }
  walk(0);
  return res;
}

export function compareEval(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const x = a.tiebreak[i] || 0;
    const y = b.tiebreak[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 从 5~7 张里取最佳 5 张
export function evaluateBest(cards) {
  if (!Array.isArray(cards) || cards.length < 5) {
    return { category: -1, tiebreak: [], cards: [], name: '牌数不足' };
  }
  const combos = combinations(cards, 5);
  let best = null;
  for (const c of combos) {
    const ev = evaluateFive(c);
    if (!best || compareEval(ev, best) > 0) best = ev;
  }
  best.name = HAND_NAMES[best.category];
  return best;
}

export function describeEval(ev) {
  if (!ev || ev.category < 0) return '—';
  const lab = v => (RANKS.find(r => r.v === v) || { label: '?' }).label;
  switch (ev.category) {
    case 9: return '皇家同花顺';
    case 8: return `同花顺 · ${lab(ev.tiebreak[0])} 高`;
    case 7: return `四条 ${lab(ev.tiebreak[0])}`;
    case 6: return `葫芦 ${lab(ev.tiebreak[0])} 带 ${lab(ev.tiebreak[1])}`;
    case 5: return `同花 · ${lab(ev.tiebreak[0])} 高`;
    case 4: return `顺子 · ${lab(ev.tiebreak[0])} 高`;
    case 3: return `三条 ${lab(ev.tiebreak[0])}`;
    case 2: return `两对 ${lab(ev.tiebreak[0])} & ${lab(ev.tiebreak[1])}`;
    case 1: return `一对 ${lab(ev.tiebreak[0])}`;
    default: return `高牌 ${lab(ev.tiebreak[0])}`;
  }
}

// 蒙特卡洛胜率估算
export function estimateEquity(hole, community, opponentCount, iterations = 1200) {
  if (!hole || hole.length < 2) return 0;
  const used = new Set([...hole, ...community].map(c => c.id));
  const pool = createDeck().filter(c => !used.has(c.id));
  const needBoard = 5 - community.length;
  let win = 0, tie = 0;

  for (let it = 0; it < iterations; it++) {
    const bag = pool.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    let p = 0;
    const board = community.concat(bag.slice(p, p + needBoard));
    p += needBoard;
    const mine = evaluateBest(hole.concat(board));
    let better = 0, equal = 0;
    for (let o = 0; o < opponentCount; o++) {
      const oh = [bag[p++], bag[p++]];
      const ev = evaluateBest(oh.concat(board));
      const cmp = compareEval(ev, mine);
      if (cmp > 0) better++;
      else if (cmp === 0) equal++;
    }
    if (better === 0) { if (equal === 0) win++; else tie++; }
  }
  return (win + tie * 0.5) / iterations;
}

// 起手牌强度 0~1（简化 Chen 公式归一化）
export function preflopStrength(hole) {
  if (!hole || hole.length < 2) return 0;
  const [a, b] = hole.slice().sort((x, y) => y.value - x.value);
  const highMap = { 14: 10, 13: 8, 12: 7, 11: 6 };
  let score = highMap[a.value] || a.value / 2;
  if (a.value === b.value) {
    score = Math.max(score * 2, 5);
  } else {
    if (a.suit === b.suit) score += 2;
    const gap = a.value - b.value - 1;
    if (gap === 1) score -= 1;
    else if (gap === 2) score -= 2;
    else if (gap === 3) score -= 4;
    else if (gap >= 4) score -= 5;
    if (gap <= 1 && a.value < 12) score += 1;
  }
  return Math.max(0, Math.min(1, score / 20));
}
