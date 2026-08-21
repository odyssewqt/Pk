// 游戏引擎：状态机、下注轮、边池结算
import { createDeck, shuffle, evaluateBest, compareEval, describeEval } from './poker.js';
import { decideAction } from './ai.js';

export const STAGES = ['preflop', 'flop', 'turn', 'river', 'showdown'];
export const STAGE_LABEL = {
  idle: '等待开始',
  preflop: '翻牌前 PRE-FLOP',
  flop: '翻牌 FLOP',
  turn: '转牌 TURN',
  river: '河牌 RIVER',
  showdown: '开牌 SHOWDOWN',
  over: '本局结束'
};

const AI_PROFILES = [
  { name: '铁面老张', style: 'tight', avatar: '🧔', desc: '紧凶型，只玩好牌但下手极重' },
  { name: '疯狂莉莉', style: 'loose', avatar: '👩‍🎤', desc: '松散型，爱诈唬，牌局节奏快' },
  { name: '算牌博士', style: 'balanced', avatar: '👨‍🔬', desc: '均衡型，依赖概率精准决策' }
];

export class PokerGame {
  constructor(options = {}) {
    this.smallBlind = options.smallBlind || 25;
    this.bigBlind = this.smallBlind * 2;
    this.startingStack = options.startingStack || 2000;
    this.listeners = {};
    this.handNo = 0;
    this.record = { hands: 0, wins: 0, losses: 0, biggestPot: 0, bluffCatch: 0 };
    // 联机模式：seats 为座位描述数组，heroSeatId 指明本客户端占哪个座位
    this.seats = options.seats || null;
    this.heroSeatId = options.heroSeatId != null ? options.heroSeatId : 0;
    // 联机模式下 AI 与流程只在房主端推进
    this.isAuthority = options.isAuthority !== false;
    this.initPlayers();
    this.resetTableState();
  }

  on(evt, fn) {
    (this.listeners[evt] = this.listeners[evt] || []).push(fn);
    return this;
  }

  emit(evt, payload) {
    (this.listeners[evt] || []).forEach(fn => fn(payload));
  }

  initPlayers() {
    if (this.seats && this.seats.length) {
      // 联机模式：按座位表建人，真人座位带 owner，空位用 AI 补
      let aiCursor = 0;
      this.players = this.seats.map((seat, idx) => {
        if (seat.type === 'human') {
          return {
            id: idx,
            name: seat.name || `玩家${idx + 1}`,
            isHero: idx === this.heroSeatId,
            avatar: seat.avatar || '🙂',
            style: 'hero',
            desc: '真人玩家',
            seatOwner: seat.owner || null,
            isAI: false,
            stack: this.startingStack
          };
        }
        const prof = AI_PROFILES[aiCursor % AI_PROFILES.length];
        aiCursor++;
        return {
          id: idx,
          name: prof.name,
          isHero: false,
          avatar: prof.avatar,
          style: prof.style,
          desc: prof.desc,
          seatOwner: null,
          isAI: true,
          stack: this.startingStack
        };
      });
    } else {
      this.players = [
        { id: 0, name: '你', isHero: true, avatar: '🙂', style: 'hero', desc: '玩家本人', isAI: false, stack: this.startingStack },
        ...AI_PROFILES.map((p, i) => ({ id: i + 1, name: p.name, isHero: false, avatar: p.avatar, style: p.style, desc: p.desc, isAI: true, stack: this.startingStack }))
      ];
    }
    this.players.forEach(p => {
      p.hole = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = false;
      p.allIn = false;
      p.acted = false;
      p.lastAction = '';
      p.showCards = false;
      p.eval = null;
      p.winAmount = 0;
    });
    this.dealerIndex = Math.floor(Math.random() * this.players.length);
  }

  resetTableState() {
    this.deck = [];
    this.community = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.stage = 'idle';
    this.activeIndex = -1;
    this.lastAggressor = -1;
    this.logs = [];
    this.results = null;
    this.awaitingHero = false;
  }

  log(text, type = 'info') {
    const entry = { text, type, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }) };
    this.logs.push(entry);
    this.emit('log', entry);
  }

  livePlayers() { return this.players.filter(p => !p.folded); }
  contenders() { return this.players.filter(p => !p.folded); }
  actionable() { return this.players.filter(p => !p.folded && !p.allIn && p.stack > 0); }

  bustedCount() { return this.players.filter(p => p.stack <= 0).length; }

  startHand() {
    const alive = this.players.filter(p => p.stack > 0);
    if (alive.length < 2) {
      this.stage = 'over';
      this.log('游戏结束：可用玩家不足两人。', 'warn');
      this.emit('gameOver', { hero: this.heroPlayer() });
      this.emit('update');
      return;
    }
    this.handNo++;
    this.resetTableState();
    this.stage = 'preflop';
    this.deck = shuffle(createDeck());

    this.players.forEach(p => {
      p.hole = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = p.stack <= 0;
      p.allIn = false;
      p.acted = false;
      p.lastAction = p.stack <= 0 ? '淘汰' : '';
      p.showCards = false;
      p.eval = null;
      p.winAmount = 0;
    });

    // 移动庄家按钮到下一个有筹码玩家
    do { this.dealerIndex = (this.dealerIndex + 1) % this.players.length; }
    while (this.players[this.dealerIndex].stack <= 0);

    // 发底牌
    for (let r = 0; r < 2; r++) {
      for (const p of this.players) {
        if (p.stack > 0) p.hole.push(this.deck.pop());
      }
    }

    const order = this.seatOrderFrom(this.dealerIndex + 1);
    const sbPlayer = order[0];
    const bbPlayer = order[1 % order.length];
    this.postBlind(sbPlayer, this.smallBlind, '小盲');
    this.postBlind(bbPlayer, this.bigBlind, '大盲');
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.lastAggressor = bbPlayer.id;

    this.log(`—— 第 ${this.handNo} 手开始 · 庄家：${this.players[this.dealerIndex].name} ——`, 'stage');
    this.log(`盲注 ${this.smallBlind}/${this.bigBlind}`, 'info');

    const startIdx = order.length > 2 ? 2 % order.length : 0;
    this.activeIndex = order[startIdx].id;
    this.emit('handStart');
    this.emit('update');
    this.advance();
  }

  seatOrderFrom(startIdx) {
    const res = [];
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[(startIdx + i) % this.players.length];
      if (p.stack > 0) res.push(p);
    }
    return res;
  }

  postBlind(player, amount, label) {
    const pay = Math.min(amount, player.stack);
    player.stack -= pay;
    player.bet += pay;
    player.totalBet += pay;
    this.pot += pay;
    if (player.stack === 0) player.allIn = true;
    player.lastAction = `${label} ${pay}`;
  }

  nextActor(fromId) {
    for (let i = 1; i <= this.players.length; i++) {
      const p = this.players[(fromId + i) % this.players.length];
      if (!p.folded && !p.allIn && p.stack > 0) return p.id;
    }
    return -1;
  }

  bettingRoundComplete() {
    const act = this.actionable();
    if (act.length === 0) return true;
    if (this.contenders().length <= 1) return true;
    return act.every(p => p.acted && p.bet === this.currentBet);
  }

  advance() {
    if (this.contenders().length <= 1) { this.finishByFold(); return; }

    if (this.bettingRoundComplete()) {
      this.nextStage();
      return;
    }

    const id = this.activeIndex >= 0 && !this.players[this.activeIndex].folded && !this.players[this.activeIndex].allIn && this.players[this.activeIndex].stack > 0
      ? this.activeIndex
      : this.nextActor(this.activeIndex < 0 ? this.dealerIndex : this.activeIndex);

    if (id < 0) { this.nextStage(); return; }
    this.activeIndex = id;
    const player = this.players[id];

    if (player.isAI) {
      // AI 由权威端驱动
      this.awaitingHero = false;
      this.emit('update');
      if (this.isAuthority) {
        const delay = 700 + Math.random() * 700;
        setTimeout(() => this.runAI(player), delay);
      }
    } else if (player.isHero) {
      this.awaitingHero = true;
      this.emit('heroTurn', this.heroOptions());
      this.emit('update');
    } else {
      // 其他真人玩家：等他的客户端回传动作
      this.awaitingHero = false;
      this.emit('waitRemote', player);
      this.emit('update');
    }
  }

  runAI(player) {
    if (player.folded || player.allIn || this.stage === 'over') { return; }
    const decision = decideAction({
      player,
      game: this,
      community: this.community,
      currentBet: this.currentBet,
      pot: this.pot,
      minRaise: this.minRaise,
      opponents: this.contenders().length - 1
    });
    this.applyAction(player.id, decision.action, decision.amount, decision.speech);
  }

  heroPlayer() {
    return this.players.find(p => p.isHero) || this.players[0];
  }

  heroOptions() {
    const hero = this.heroPlayer();
    const toCall = Math.max(0, this.currentBet - hero.bet);
    const canCheck = toCall === 0;
    const maxRaiseTotal = hero.bet + hero.stack;
    const minRaiseTotal = Math.min(maxRaiseTotal, Math.max(this.currentBet + this.minRaise, this.bigBlind));
    return {
      toCall: Math.min(toCall, hero.stack),
      canCheck,
      canRaise: maxRaiseTotal > this.currentBet,
      minRaiseTotal,
      maxRaiseTotal,
      pot: this.pot,
      stack: hero.stack
    };
  }

  applyAction(playerId, action, amount = 0, speech = '') {
    const player = this.players[playerId];
    if (!player || player.folded || this.stage === 'over') return;
    const toCall = Math.max(0, this.currentBet - player.bet);

    if (action === 'fold') {
      player.folded = true;
      player.lastAction = '弃牌';
      this.log(`${player.name} 弃牌${speech ? ' · ' + speech : ''}`, 'fold');
    } else if (action === 'check') {
      player.lastAction = '过牌';
      this.log(`${player.name} 过牌${speech ? ' · ' + speech : ''}`, 'check');
    } else if (action === 'call') {
      const pay = Math.min(toCall, player.stack);
      player.stack -= pay; player.bet += pay; player.totalBet += pay; this.pot += pay;
      if (player.stack === 0) player.allIn = true;
      player.lastAction = player.allIn ? `All-in ${pay}` : `跟注 ${pay}`;
      this.log(`${player.name} 跟注 ${pay}${player.allIn ? '（All-in）' : ''}${speech ? ' · ' + speech : ''}`, 'call');
    } else if (action === 'raise' || action === 'bet' || action === 'allin') {
      let target = action === 'allin' ? player.bet + player.stack : amount;
      target = Math.max(target, this.currentBet + (action === 'allin' ? 0 : this.minRaise));
      target = Math.min(target, player.bet + player.stack);
      const pay = target - player.bet;
      player.stack -= pay; player.bet = target; player.totalBet += pay; this.pot += pay;
      if (player.stack === 0) player.allIn = true;
      const raiseSize = target - this.currentBet;
      if (raiseSize > 0) {
        this.minRaise = Math.max(this.minRaise, raiseSize);
        this.currentBet = target;
        this.lastAggressor = player.id;
        this.players.forEach(p => { if (p.id !== player.id && !p.folded && !p.allIn) p.acted = false; });
      }
      const verb = toCall === 0 ? '下注' : '加注至';
      player.lastAction = player.allIn ? `All-in ${target}` : `${verb} ${target}`;
      this.log(`${player.name} ${verb} ${target}${player.allIn ? '（All-in）' : ''}${speech ? ' · ' + speech : ''}`, 'raise');
    }

    player.acted = true;
    this.emit('action', { player, action, amount });
    this.activeIndex = this.nextActor(player.id);
    this.emit('update');
    setTimeout(() => this.advance(), 250);
  }

  nextStage() {
    this.players.forEach(p => { p.bet = 0; p.acted = false; });
    this.currentBet = 0;
    this.minRaise = this.bigBlind;

    if (this.stage === 'preflop') {
      this.stage = 'flop';
      this.deck.pop();
      this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.log(`翻牌：${this.community.map(c => c.label + c.symbol).join(' ')}`, 'stage');
    } else if (this.stage === 'flop') {
      this.stage = 'turn';
      this.deck.pop();
      this.community.push(this.deck.pop());
      this.log(`转牌：${this.community[3].label}${this.community[3].symbol}`, 'stage');
    } else if (this.stage === 'turn') {
      this.stage = 'river';
      this.deck.pop();
      this.community.push(this.deck.pop());
      this.log(`河牌：${this.community[4].label}${this.community[4].symbol}`, 'stage');
    } else {
      this.showdown();
      return;
    }

    this.emit('stageChange', this.stage);
    this.emit('update');

    if (this.actionable().length <= 1) {
      setTimeout(() => this.nextStage(), 900);
      return;
    }
    this.activeIndex = this.nextActor(this.dealerIndex);
    setTimeout(() => this.advance(), 800);
  }

  finishByFold() {
    const winner = this.contenders()[0];
    if (!winner) { this.stage = 'over'; this.emit('update'); return; }
    winner.stack += this.pot;
    winner.winAmount = this.pot;
    this.record.biggestPot = Math.max(this.record.biggestPot, this.pot);
    this.log(`${winner.name} 赢得底池 ${this.pot}（其他人全部弃牌）`, 'win');
    this.results = { winners: [{ player: winner, amount: this.pot, evalName: '无需开牌' }], pots: [] };
    this.pot = 0;
    this.stage = 'over';
    this.settleRecord(winner);
    this.emit('handEnd', this.results);
    this.emit('update');
  }

  buildSidePots() {
    const involved = this.players.filter(p => p.totalBet > 0);
    const levels = [...new Set(involved.map(p => p.totalBet))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lv of levels) {
      let amount = 0;
      const eligible = [];
      for (const p of involved) {
        const contrib = Math.min(p.totalBet, lv) - Math.min(p.totalBet, prev);
        if (contrib > 0) amount += contrib;
        if (p.totalBet >= lv && !p.folded) eligible.push(p);
      }
      if (amount > 0 && eligible.length > 0) pots.push({ amount, eligible });
      else if (amount > 0 && pots.length) pots[pots.length - 1].amount += amount;
      prev = lv;
    }
    return pots;
  }

  showdown() {
    this.stage = 'showdown';
    const cont = this.contenders();
    cont.forEach(p => {
      p.eval = evaluateBest(p.hole.concat(this.community));
      p.showCards = true;
    });
    this.emit('update');

    const pots = this.buildSidePots();
    const winnersAgg = new Map();

    pots.forEach((pot, idx) => {
      let best = null;
      for (const p of pot.eligible) {
        if (!best || compareEval(p.eval, best.eval) > 0) best = p;
      }
      const tied = pot.eligible.filter(p => compareEval(p.eval, best.eval) === 0);
      const share = Math.floor(pot.amount / tied.length);
      let remainder = pot.amount - share * tied.length;
      tied.forEach((p, i) => {
        const gain = share + (i < remainder ? 1 : 0);
        p.stack += gain;
        p.winAmount += gain;
        winnersAgg.set(p.id, (winnersAgg.get(p.id) || 0) + gain);
      });
      const label = pots.length > 1 ? (idx === 0 ? '主池' : `边池${idx}`) : '底池';
      this.log(`${label} ${pot.amount} → ${tied.map(p => p.name).join(' / ')}（${describeEval(best.eval)}）`, 'win');
    });

    cont.forEach(p => this.log(`${p.name} 亮牌 ${p.hole.map(c => c.label + c.symbol).join(' ')} → ${describeEval(p.eval)}`, 'reveal'));

    this.record.biggestPot = Math.max(this.record.biggestPot, this.pot);
    const winners = [...winnersAgg.entries()].map(([id, amount]) => ({
      player: this.players[id], amount, evalName: describeEval(this.players[id].eval)
    })).sort((a, b) => b.amount - a.amount);

    this.results = { winners, pots };
    this.pot = 0;
    this.stage = 'over';
    const heroWon = winners.some(w => w.player.isHero);
    this.settleRecord(heroWon ? this.heroPlayer() : winners[0]?.player);
    this.emit('handEnd', this.results);
    this.emit('update');
  }

  settleRecord(winner) {
    this.record.hands++;
    if (winner && winner.isHero) this.record.wins++;
    else this.record.losses++;
    const hero = this.heroPlayer();
    if (hero && hero.stack <= 0) {
      setTimeout(() => this.emit('gameOver', { hero }), 400);
    }
  }
}
