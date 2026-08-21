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

export const MAX_SEATS = 6;

const AI_PROFILES = [
  { name: '铁面老张', style: 'tight', avatar: '🧔', desc: '紧凶型，只玩好牌但下手极重' },
  { name: '疯狂莉莉', style: 'loose', avatar: '👩‍🎤', desc: '松散型，爱诈唬，牌局节奏快' },
  { name: '算牌博士', style: 'balanced', avatar: '👨‍🔬', desc: '均衡型，依赖概率精准决策' },
  { name: '石佛老陈', style: 'tight', avatar: '🧙', desc: '岩石型，极度保守，出手必是大牌' },
  { name: '赌狗阿飞', style: 'loose', avatar: '🤠', desc: '莽夫型，动辄全下，毫无耐心' },
  { name: '教授王', style: 'balanced', avatar: '👨‍🏫', desc: '学院派，擅长读牌与控池' }
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
    const seats = (this.seats && this.seats.length)
      ? this.seats
      : [{ type: 'human', owner: 'local', name: '你', avatar: '🙂' },
         { type: 'ai' }, { type: 'ai' }, { type: 'ai' }];

    let aiCursor = 0;
    this.players = seats.map((seat, idx) => {
      if (seat.type === 'human' && seat.owner) {
        return {
          id: idx,
          name: seat.name || `玩家${idx + 1}`,
          isHero: idx === this.heroSeatId,
          avatar: seat.avatar || '🙂',
          style: 'hero',
          desc: '真人玩家',
          seatOwner: seat.owner,
          isAI: false,
          empty: false,
          stack: seat.stack != null ? seat.stack : this.startingStack
        };
      }
      if (seat.type === 'ai') {
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
          empty: false,
          stack: seat.stack != null ? seat.stack : this.startingStack
        };
      }
      // 空座位：不参与牌局，等牌局间隙有人坐下
      return {
        id: idx,
        name: '空位',
        isHero: false,
        avatar: '⬜',
        style: 'balanced',
        desc: '虚位以待',
        seatOwner: null,
        isAI: false,
        empty: true,
        stack: 0
      };
    });

    this.players.forEach(p => {
      p.hole = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = p.empty;
      p.allIn = false;
      p.acted = false;
      p.lastAction = '';
      p.showCards = false;
      p.eval = null;
      p.winAmount = 0;
    });
    if (this.dealerIndex == null) {
      this.dealerIndex = Math.floor(Math.random() * this.players.length);
    }
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

  livePlayers() { return this.players.filter(p => !p.empty && !p.folded); }
  contenders() { return this.players.filter(p => !p.empty && !p.folded); }
  actionable() { return this.players.filter(p => !p.empty && !p.folded && !p.allIn && p.stack > 0); }

  bustedCount() { return this.players.filter(p => !p.empty && p.stack <= 0).length; }

  // 参与本手的座位：非空且有筹码
  seatedPlayers() { return this.players.filter(p => !p.empty && p.stack > 0); }

  startHand() {
    const alive = this.seatedPlayers();
    if (alive.length < 2) {
      this.stage = 'over';
      this.log('人数不足两人，无法开局。', 'warn');
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
      p.folded = p.empty || p.stack <= 0;
      p.allIn = false;
      p.acted = false;
      p.lastAction = p.empty ? '' : (p.stack <= 0 ? '淘汰' : '');
      p.showCards = false;
      p.eval = null;
      p.winAmount = 0;
    });

    // 庄家按钮移到下一个可参与的座位
    for (let i = 1; i <= this.players.length; i++) {
      const cand = this.players[(this.dealerIndex + i) % this.players.length];
      if (!cand.empty && cand.stack > 0) { this.dealerIndex = cand.id; break; }
    }

    // 发底牌
    for (let r = 0; r < 2; r++) {
      for (const p of this.players) {
        if (!p.empty && p.stack > 0) p.hole.push(this.deck.pop());
      }
    }

    const heads = alive.length === 2;
    let sbPlayer, bbPlayer, firstToAct;

    if (heads) {
      // 单挑：庄家下小盲，翻前庄家先说话，翻后大盲先说话
      const order = this.seatOrderFrom(this.dealerIndex);
      sbPlayer = order[0];
      bbPlayer = order[1];
      firstToAct = sbPlayer;
    } else {
      // 三人以上：庄家左手位小盲，其次大盲，UTG（大盲左手）先说话
      const order = this.seatOrderFrom(this.dealerIndex + 1);
      sbPlayer = order[0];
      bbPlayer = order[1];
      firstToAct = order[2 % order.length];
    }

    this.postBlind(sbPlayer, this.smallBlind, '小盲');
    this.postBlind(bbPlayer, this.bigBlind, '大盲');
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.lastAggressor = bbPlayer.id;
    this.bbSeatId = bbPlayer.id;
    this.sbSeatId = sbPlayer.id;

    this.log(`—— 第 ${this.handNo} 手开始 · ${alive.length} 人 · 庄家：${this.players[this.dealerIndex].name} ——`, 'stage');
    this.log(`盲注 ${this.smallBlind}/${this.bigBlind}`, 'info');

    this.activeIndex = firstToAct.id;
    this.emit('handStart');
    this.emit('update');
    this.advance();
  }

  seatOrderFrom(startIdx) {
    const res = [];
    const n = this.players.length;
    for (let i = 0; i < n; i++) {
      const p = this.players[((startIdx % n) + n + i) % n];
      if (!p.empty && p.stack > 0) res.push(p);
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
    const n = this.players.length;
    const base = ((fromId % n) + n) % n;
    for (let i = 1; i <= n; i++) {
      const p = this.players[(base + i) % n];
      if (!p.empty && !p.folded && !p.allIn && p.stack > 0) return p.id;
    }
    return -1;
  }

  // nextActor 只会从锚点向前搜索，所以想让某个座位成为首位行动者，
  // 需要把锚点放在它的前一位
  prevActorAnchor(seatId) {
    const n = this.players.length;
    return ((seatId % n) + n - 1) % n;
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
    // 翻后行动顺序：三人以上从庄家左手位（小盲）开始；
    // 单挑时庄家兼小盲，翻后必须由大盲先说话，因此从大盲位起算
    const heads = this.seatedPlayers().length === 2;
    const anchor = heads && this.bbSeatId != null
      ? this.prevActorAnchor(this.bbSeatId)
      : this.dealerIndex;
    this.activeIndex = this.nextActor(anchor);
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
    const involved = this.players.filter(p => !p.empty && p.totalBet > 0);
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

  // 牌局间隙生效：按新座位表重建玩家，已在座者保留筹码，新入座者拿起始筹码
  applySeats(newSeats) {
    if (this.stage !== 'idle' && this.stage !== 'over') return false;
    const prevByOwner = new Map();
    const prevBySeat = new Map();
    this.players.forEach(p => {
      if (p.seatOwner) prevByOwner.set(p.seatOwner, p);
      prevBySeat.set(p.id, p);
    });

    this.seats = newSeats.map((seat, idx) => {
      if (seat.type === 'human' && seat.owner) {
        const old = prevByOwner.get(seat.owner);
        return { ...seat, stack: old && old.stack > 0 ? old.stack : this.startingStack };
      }
      if (seat.type === 'ai') {
        const old = prevBySeat.get(idx);
        const keep = old && old.isAI && old.stack > 0 ? old.stack : this.startingStack;
        return { ...seat, stack: keep };
      }
      return { type: 'empty' };
    });

    const keepDealer = this.dealerIndex;
    this.initPlayers();
    this.dealerIndex = keepDealer;
    this.resetTableState();
    this.emit('update');
    return true;
  }
}
