// UI 渲染模块：卡牌、座位、公共牌、日志、弹窗
import { describeEval, evaluateBest, estimateEquity, preflopStrength, HAND_NAMES } from './poker.js';
import { STAGE_LABEL } from './engine.js';

const $ = id => document.getElementById(id);

export function cardHTML(card, opts = {}) {
  const size = opts.size || 'md';
  const dims = size === 'lg' ? 'w-16 h-24 text-2xl' : size === 'sm' ? 'w-10 h-14 text-sm' : 'w-14 h-20 text-xl';
  if (!card) {
    return `<div class="${dims} rounded-lg border-2 border-dashed border-white/20 bg-black/20"></div>`;
  }
  if (opts.hidden) {
    return `<div class="${dims} rounded-lg card-back border-2 border-white/40 flex items-center justify-center animate-dealIn">
      <span class="text-white/70 text-lg">♠</span></div>`;
  }
  return `<div class="${dims} rounded-lg card-face border border-slate-300 flex flex-col items-center justify-center font-black ${card.color} animate-flipIn ${opts.highlight ? 'ring-4 ring-gold scale-105' : ''}">
    <span class="leading-none">${card.label}</span>
    <span class="leading-none">${card.symbol}</span>
  </div>`;
}

function chipHTML(amount) {
  if (!amount) return '';
  return `<div class="animate-chipPop flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/50 border border-gold/60 text-gold text-xs font-bold">
    <span class="w-2.5 h-2.5 rounded-full chip-ring inline-block"></span>${amount}</div>`;
}

const STYLE_TAG = {
  tight: { text: '紧凶', cls: 'bg-sky-500/20 text-sky-300 border-sky-400/40' },
  loose: { text: '松散', cls: 'bg-rose-500/20 text-rose-300 border-rose-400/40' },
  balanced: { text: '均衡', cls: 'bg-violet-500/20 text-violet-300 border-violet-400/40' },
  maniac: { text: '疯狂', cls: 'bg-orange-500/20 text-orange-300 border-orange-400/40' },
  rock: { text: '岩石', cls: 'bg-teal-500/20 text-teal-300 border-teal-400/40' },
  station: { text: '跟注站', cls: 'bg-lime-500/20 text-lime-300 border-lime-400/40' },
  hero: { text: '我', cls: 'bg-amber-500/20 text-amber-300 border-amber-400/40' },
  human: { text: '真人', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40' }
};

// 计算小盲/大盲座位，用于座位角标。与引擎保持同一套规则：
// 两人时庄家即小盲，三人以上庄家左手位为小盲
function blindSeats(game) {
  // 引擎已记录权威盲注座位时直接采用，避免UI重复推导产生偏差
  if (game.sbSeatId != null && game.bbSeatId != null && game.sbSeatId >= 0) {
    return { sb: game.sbSeatId, bb: game.bbSeatId };
  }
  const alive = [];
  for (let i = 0; i < game.players.length; i++) {
    const p = game.players[(game.dealerIndex + i) % game.players.length];
    if (p.stack > 0 || p.totalBet > 0) alive.push(p.id);
  }
  if (alive.length < 2) return { sb: -1, bb: -1 };
  if (alive.length === 2) return { sb: alive[0], bb: alive[1] };
  return { sb: alive[1], bb: alive[2] };
}

function seatHTML(game, player, isHero, blinds) {
  const active = game.activeIndex === player.id && game.stage !== 'over' && game.stage !== 'idle';
  const isDealer = game.dealerIndex === player.id;
  const isSB = blinds && blinds.sb === player.id;
  const isBB = blinds && blinds.bb === player.id;
  const busted = player.stack <= 0 && player.folded;
  const tag = player.isAI ? (STYLE_TAG[player.style] || STYLE_TAG.balanced) : (isHero ? STYLE_TAG.hero : STYLE_TAG.human);
  const reveal = player.showCards || isHero;
  const winner = player.winAmount > 0;
  const holeKnown = player.hole.filter(Boolean);
  const holeCount = player.hole.length;

  const cards = holeCount
    ? player.hole.map(c => cardHTML(c, { hidden: !reveal || !c, size: isHero ? 'lg' : 'sm' })).join('')
    : `${cardHTML(null, { size: isHero ? 'lg' : 'sm' })}${cardHTML(null, { size: isHero ? 'lg' : 'sm' })}`;

  const evalText = reveal && holeKnown.length >= 2 && game.community.length >= 3
    ? describeEval(evaluateBest(holeKnown.concat(game.community)))
    : '';

  return `<div class="rounded-2xl border ${active ? 'border-gold seat-active' : winner ? 'border-emerald-400' : 'border-white/15'} ${player.folded && !busted ? 'opacity-45' : ''} ${busted ? 'opacity-30 grayscale' : ''} bg-black/35 backdrop-blur p-3 ${isHero ? 'md:flex md:items-center md:gap-6' : ''} transition-all">
    <div class="flex items-center gap-3 ${isHero ? 'md:flex-1' : ''}">
      <div class="w-11 h-11 rounded-full bg-gradient-to-br from-slate-600 to-slate-800 border border-white/20 flex items-center justify-center text-xl shrink-0">${player.avatar}</div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5 flex-wrap">
          <span class="font-bold text-sm truncate">${player.name}</span>
          <span class="px-1.5 py-0.5 rounded border text-[10px] ${tag.cls}">${tag.text}</span>
          ${isDealer ? '<span class="w-5 h-5 rounded-full bg-white text-ink text-[10px] font-black flex items-center justify-center">D</span>' : ''}
          ${isSB ? '<span class="w-5 h-5 rounded-full bg-sky-400 text-ink text-[10px] font-black flex items-center justify-center">SB</span>' : ''}
          ${isBB ? '<span class="w-5 h-5 rounded-full bg-amber-400 text-ink text-[10px] font-black flex items-center justify-center">BB</span>' : ''}
        </div>
        <div class="flex items-center gap-2 mt-0.5">
          <span class="text-gold font-mono font-bold text-sm">${player.stack}</span>
          ${chipHTML(player.bet)}
        </div>
        <div class="text-[11px] mt-0.5 ${player.folded ? 'text-rose-300' : 'text-emerald-200/80'} truncate h-4">${busted ? '已淘汰' : player.lastAction || ''}</div>
      </div>
    </div>
    <div class="flex items-center gap-2 mt-2 ${isHero ? 'md:mt-0' : ''}">${cards}</div>
    ${isHero ? `<div class="md:flex-1 md:text-right mt-2 md:mt-0">
        <div class="text-[11px] text-slate-400">当前牌型</div>
        <div class="text-sm font-bold text-emerald-300 h-5">${evalText || '—'}</div>
      </div>` : (evalText ? `<div class="text-[11px] text-emerald-300 mt-1">${evalText}</div>` : '')}
    ${winner ? `<div class="text-emerald-300 text-xs font-bold mt-1">+${player.winAmount}</div>` : ''}
  </div>`;
}

function heroOf(game) {
  return game.players.find(p => p.isHero) || game.players[0];
}

export function renderTable(game) {
  const hero = heroOf(game);
  const blinds = blindSeats(game);
  // 按座位号顺时针排列对手，从本人下一个座位开始，视觉上更贴近真实牌桌
  const total = game.players.length;
  const opps = [];
  for (let i = 1; i < total; i++) {
    const p = game.players[(hero.id + i) % total];
    if (p && !p.isHero) opps.push(p);
  }
  const cols = opps.length <= 2 ? 'sm:grid-cols-2' : opps.length <= 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3 lg:grid-cols-5';
  const wrap = $('opponentSeats');
  wrap.className = `grid grid-cols-1 ${cols} gap-3`;
  wrap.innerHTML = opps.map(p => seatHTML(game, p, false, blinds)).join('');
  $('heroSeat').innerHTML = seatHTML(game, hero, true, blinds);

  $('potDisplay').textContent = game.pot;
  $('stageBadge').textContent = STAGE_LABEL[game.stage] || game.stage;

  const slots = [0, 1, 2, 3, 4];
  $('communityCards').innerHTML = slots.map(i => {
    const c = game.community[i];
    return c ? cardHTML(c, { size: 'lg' }) : cardHTML(null, { size: 'lg' });
  }).join('');

  renderStats(game);
  renderStrength(game);
  renderRecord(game);
}

function renderStats(game) {
  const hero = heroOf(game);
  const humans = game.players.filter(p => !p.isAI).length;
  const alive = game.players.filter(p => p.stack > 0 || p.totalBet > 0).length;
  const items = [
    { label: '手数', value: game.handNo, icon: 'ri-layout-grid-line' },
    { label: '我的筹码', value: hero.stack, icon: 'ri-coin-line' },
    { label: '在座', value: `${alive}人（真人${humans}）`, icon: 'ri-group-line' },
    { label: '盲注', value: `${game.smallBlind}/${game.bigBlind}`, icon: 'ri-focus-3-line' }
  ];
  $('statBar').innerHTML = items.map(i => `
    <div class="px-3 py-1.5 rounded-lg bg-black/40 border border-white/10 flex items-center gap-1.5">
      <i class="${i.icon} text-gold"></i>
      <span class="text-slate-400">${i.label}</span>
      <span class="font-mono font-bold text-white">${i.value}</span>
    </div>`).join('');
}

let equityCache = { key: '', value: 0 };

function renderStrength(game) {
  const hero = heroOf(game);
  const panel = $('strengthPanel');
  const heroHole = hero ? hero.hole.filter(Boolean) : [];
  if (heroHole.length < 2) {
    panel.innerHTML = `<p class="text-xs text-slate-400">尚未发牌，点击「开始新一局」进入牌局。</p>`;
    $('handStrengthTag').textContent = '—';
    return;
  }

  const key = heroHole.map(c => c.id).join('') + '|' + game.community.map(c => c.id).join('');
  let equity;
  if (equityCache.key === key) {
    equity = equityCache.value;
  } else {
    const opp = Math.max(1, game.contenders().length - 1);
    equity = game.community.length === 0
      ? 0.2 + preflopStrength(heroHole) * 0.65
      : estimateEquity(heroHole, game.community, opp, 1500);
    equityCache = { key, value: equity };
  }

  const ev = game.community.length >= 3 ? evaluateBest(heroHole.concat(game.community)) : null;
  const pct = Math.round(equity * 100);
  $('handStrengthTag').textContent = ev ? ev.name : '起手牌';

  const potOdds = (() => {
    const toCall = Math.max(0, game.currentBet - hero.bet);
    if (toCall <= 0) return 0;
    return Math.round(toCall / (game.pot + toCall) * 100);
  })();

  const barColor = pct >= 60 ? 'bg-emerald-500' : pct >= 35 ? 'bg-amber-500' : 'bg-rose-500';

  panel.innerHTML = `
    <div>
      <div class="flex justify-between text-xs mb-1"><span class="text-slate-400">预估胜率</span><span class="font-mono font-bold text-white">${pct}%</span></div>
      <div class="h-2.5 rounded-full bg-white/10 overflow-hidden"><div class="h-full ${barColor} transition-all duration-500" style="width:${pct}%"></div></div>
    </div>
    <div>
      <div class="flex justify-between text-xs mb-1"><span class="text-slate-400">底池赔率（需胜率）</span><span class="font-mono font-bold text-white">${potOdds}%</span></div>
      <div class="h-2.5 rounded-full bg-white/10 overflow-hidden"><div class="h-full bg-sky-500 transition-all duration-500" style="width:${potOdds}%"></div></div>
    </div>
    <div class="grid grid-cols-2 gap-2 text-xs pt-1">
<div class="rounded-lg bg-white/5 p-2"><div class="text-slate-400">我的手牌</div><div class="font-bold">${heroHole.map(c => c.label + c.symbol).join(' ')}</div></div>
      <div class="rounded-lg bg-white/5 p-2"><div class="text-slate-400">成手牌型</div><div class="font-bold text-emerald-300">${ev ? describeEval(ev) : '等待翻牌'}</div></div>
    </div>
    <div class="rounded-lg bg-white/5 p-2 text-xs">
      <div class="text-slate-400 mb-1">决策建议</div>
      <div class="font-bold ${equity * 100 > potOdds + 8 ? 'text-emerald-300' : equity * 100 > potOdds ? 'text-amber-300' : 'text-rose-300'}">
        ${suggestText(equity * 100, potOdds)}
      </div>
    </div>`;
}

function suggestText(eq, odds) {
  if (odds === 0) return eq > 62 ? '牌力占优，建议主动下注施压' : eq > 40 ? '可以过牌控池，观察对手' : '牌力偏弱，建议过牌';
  if (eq > odds + 15) return '胜率显著高于赔率，建议跟注或加注';
  if (eq > odds + 3) return '略有优势，可以跟注';
  if (eq > odds - 5) return '边缘情况，谨慎跟注或弃牌';
  return '赔率不划算，建议弃牌';
}

function renderRecord(game) {
  const r = game.record;
  const rate = r.hands ? Math.round(r.wins / r.hands * 100) : 0;
  const items = [
    { label: '总手数', value: r.hands, color: 'text-white' },
    { label: '胜局', value: r.wins, color: 'text-emerald-300' },
    { label: '胜率', value: rate + '%', color: 'text-gold' },
    { label: '最大底池', value: r.biggestPot, color: 'text-sky-300' }
  ];
  $('recordPanel').innerHTML = items.map(i => `
    <div class="rounded-xl bg-white/5 p-3">
      <div class="text-lg font-black ${i.color}">${i.value}</div>
      <div class="text-[11px] text-slate-400 mt-0.5">${i.label}</div>
    </div>`).join('');
}

const LOG_STYLE = {
  info: 'text-slate-400', stage: 'text-gold font-bold', fold: 'text-rose-300',
  call: 'text-sky-300', raise: 'text-amber-300', check: 'text-slate-300',
  win: 'text-emerald-300 font-bold', reveal: 'text-violet-300', warn: 'text-rose-400 font-bold'
};

export function appendLog(entry) {
  const list = $('logList');
  const div = document.createElement('div');
  div.className = `flex gap-2 ${LOG_STYLE[entry.type] || 'text-slate-400'}`;
  div.innerHTML = `<span class="text-slate-600 font-mono shrink-0">${entry.time}</span><span class="flex-1">${entry.text}</span>`;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

export function clearLog() { $('logList').innerHTML = ''; }

export function setTableMsg(text) { $('tableMsg').textContent = text || ''; }

export function showModal({ title, body, actions = [] }) {
  const root = $('modalRoot');
  root.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" data-overlay>
      <div class="w-full max-w-lg rounded-2xl bg-slate-900 border border-white/15 shadow-2xl overflow-hidden">
        <div class="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <h3 class="font-black text-lg text-gold">${title}</h3>
          <button data-close class="text-slate-400 hover:text-white text-xl leading-none">&times;</button>
        </div>
        <div class="p-5 max-h-[60vh] overflow-y-auto scroll-thin text-sm space-y-2">${body}</div>
        <div class="px-5 py-4 border-t border-white/10 flex flex-wrap justify-end gap-2">
          ${actions.map((a, i) => `<button data-act="${i}" class="px-4 py-2 rounded-lg text-sm font-bold ${a.primary ? 'bg-gold text-ink hover:brightness-110' : 'bg-white/10 hover:bg-white/20'} transition">${a.label}</button>`).join('')}
        </div>
      </div>
    </div>`;

  const close = () => { root.innerHTML = ''; };
  root.querySelector('[data-close]').addEventListener('click', close);
  root.querySelector('[data-overlay]').addEventListener('click', e => { if (e.target.dataset.overlay !== undefined) close(); });
  actions.forEach((a, i) => {
    root.querySelector(`[data-act="${i}"]`).addEventListener('click', () => { close(); a.onClick && a.onClick(); });
  });
}

export function resetEquityCache() { equityCache = { key: '', value: 0 }; }
