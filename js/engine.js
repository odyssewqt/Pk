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
    // 开牌后的停顿：让玩家有时间自己比较牌型，再公布赢家
    this.showdownPause = options.showdownPause || 4000;
    this.showdownPerPlayer = options.showdownPerPlayer || 600;
    // 开牌确认制：等所有真人点「看好了」再结算，最长兜底时间防挂机
    this.showdownMaxWait = options.showdownMaxWait || 30000;
    // 本手已确认看牌的座位号集合，settleShowdown 后清空
    this.showdownReady = new Set();
    this.showdownDeadline = 0;
    this.showdownTimer = null;
    this.showdownCont = null;
    // 无限大牌池：只记账，不设上限。allIn 输光后自动补码的额度
    this.autoBorrow = options.autoBorrow || this.startingStack;
    // 账本按稳定身份存放（真人用 seatOwner，AI 用 seat:序号），
    // 这样 applySeats 重建 players 后借还记录不会丢
    this.ledger = new Map();
    this.bankLog = [];
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
          stack: seat.stack != null ? seat.stack : this.startingStack,
          // 上一场没还完的欠款，随人带入，由 syncLedger 记进账本
          carryDebt: Math.max(0, Math.floor(Number(seat.debt) || 0))
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
      p.revealedByChoice = false;
      p.eval = null;
      p.winAmount = 0;
    });
    this.syncLedger();
    if (this.dealerIndex == null) {
      this.dealerIndex = Math.floor(Math.random() * this.players.length);
    }
  }

  // 账本身份：真人认 seatOwner（换座位也跟着人），AI 认座位号
  ledgerKey(p) {
    if (p.empty) return null;
    return p.seatOwner ? `owner:${p.seatOwner}` : `seat:${p.id}`;
  }

  // 把账本挂到 players 上，缺失的按当前筹码建账
  syncLedger() {
    if (!this.ledger) this.ledger = new Map();
    this.players.forEach(p => {
      const key = this.ledgerKey(p);
      if (!key) {
        p.borrowed = 0; p.repaid = 0; p.buyIn = 0; p.ledgerKey = null;
        return;
      }
      let rec = this.ledger.get(key);
      if (!rec) {
        // 首次建账：当前筹码即本人的初始买入。
        // stack 为 0 时兜底必须是 0，不能填 startingStack——否则等着被
        // autoRefillBusted 补码的人会把那 2000 记成「自带买入」，
        // 借款被抵消，净欠归零，牌池账面对不上。
        //
        // carryDebt 是上一场没还完的欠款，跟着人搬过来。记成 borrowed
        // 而不去动 buyIn：这样 net = stack - buyIn - borrowed + repaid
        // 天然把旧债扣掉，欠款继续挂在账上，不需要额外字段。
        const debt = Math.max(0, Math.floor(Number(p.carryDebt) || 0));
        rec = { borrowed: debt, repaid: 0, buyIn: p.stack > 0 ? p.stack : 0 };
        this.ledger.set(key, rec);
        if (debt > 0) {
          this.log(`${p.name} 带入上一场未结清欠款 ${debt}，继续挂在账上`, 'bank');
        }
      }
      p.ledgerKey = key;
      p.borrowed = rec.borrowed;
      p.repaid = rec.repaid;
      p.buyIn = rec.buyIn;
    });
  }

  ledgerOf(p) {
    const key = this.ledgerKey(p);
    if (!key) return null;
    if (!this.ledger.has(key)) this.syncLedger();
    return this.ledger.get(key);
  }

  // 玩家净欠牌池
  debtOf(p) {
    const rec = this.ledgerOf(p);
    if (!rec) return 0;
    return Math.max(0, rec.borrowed - rec.repaid);
  }

  // 借筹码：金额自由，牌池无限大，只记账
  borrow(playerId, amount, reason = '') {
    const p = this.players[playerId];
    if (!p || p.empty) return { ok: false, msg: '该座位不可借码' };
    const amt = Math.floor(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) return { ok: false, msg: '借入金额必须是正整数' };
    // 牌局进行中不允许改动筹码，否则会破坏当前下注轮的边池计算
    if (this.stage !== 'idle' && this.stage !== 'over') {
      return { ok: false, msg: '牌局进行中无法借码，请等本手结束' };
    }
    const rec = this.ledgerOf(p);
    rec.borrowed += amt;
    p.stack += amt;
    this.syncLedger();
    const note = `${p.name} 从牌池借入 ${amt}${reason ? `（${reason}）` : ''} · 累计借 ${rec.borrowed} / 还 ${rec.repaid} · 净欠 ${Math.max(0, rec.borrowed - rec.repaid)}`;
    this.log(note, 'bank');
    this.bankLog.push({ seatId: p.id, name: p.name, type: 'borrow', amount: amt, reason, ts: Date.now() });
    this.emit('bankChange', { player: p, type: 'borrow', amount: amt });
    this.emit('update');
    return { ok: true, amount: amt };
  }

  // 归还筹码：不能超过手上筹码，也不能超过净欠额
  repay(playerId, amount) {
    const p = this.players[playerId];
    if (!p || p.empty) return { ok: false, msg: '该座位不可还码' };
    const amt = Math.floor(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) return { ok: false, msg: '归还金额必须是正整数' };
    if (this.stage !== 'idle' && this.stage !== 'over') {
      return { ok: false, msg: '牌局进行中无法还码，请等本手结束' };
    }
    const debt = this.debtOf(p);
    if (debt <= 0) return { ok: false, msg: '你没有欠牌池筹码' };
    if (amt > debt) return { ok: false, msg: `最多只需归还 ${debt}` };
    if (amt > p.stack) return { ok: false, msg: `手上只有 ${p.stack}，不够归还 ${amt}` };
    const rec = this.ledgerOf(p);
    rec.repaid += amt;
    p.stack -= amt;
    this.syncLedger();
    this.log(`${p.name} 向牌池归还 ${amt} · 累计借 ${rec.borrowed} / 还 ${rec.repaid} · 净欠 ${Math.max(0, rec.borrowed - rec.repaid)}`, 'bank');
    this.bankLog.push({ seatId: p.id, name: p.name, type: 'repay', amount: amt, ts: Date.now() });
    this.emit('bankChange', { player: p, type: 'repay', amount: amt });
    this.emit('update');
    return { ok: true, amount: amt };
  }

  // 采纳客机自主写入的账本：借还不再经房主中转，房主只负责把
  // 账目差额兑换成实际筹码，并保持权威状态与数据库一致。
  // 只认「增量」，且借还都必须单调递增，避免旧状态回放导致重复记账。
  adoptBank(bank) {
    if (!bank || typeof bank !== 'object') return [];
    if (this.stage !== 'idle' && this.stage !== 'over') return [];
    this.syncLedger();
    const changes = [];
    this.players.forEach(p => {
      if (p.empty) return;
      const key = this.ledgerKey(p);
      const incoming = bank[key];
      if (!key || !incoming) return;
      const rec = this.ledger.get(key);
      if (!rec) return;
      const dB = Math.floor((incoming.borrowed || 0) - rec.borrowed);
      const dR = Math.floor((incoming.repaid || 0) - rec.repaid);
      if (dB > 0) {
        rec.borrowed += dB;
        p.stack += dB;
        changes.push({ seatId: p.id, name: p.name, type: 'borrow', amount: dB });
        this.bankLog.push({ seatId: p.id, name: p.name, type: 'borrow', amount: dB, reason: '玩家自助', ts: Date.now() });
        this.log(`${p.name} 从牌池借入 ${dB} · 累计借 ${rec.borrowed} / 还 ${rec.repaid} · 净欠 ${Math.max(0, rec.borrowed - rec.repaid)}`, 'bank');
      }
      if (dR > 0 && dR <= p.stack) {
        rec.repaid += dR;
        p.stack -= dR;
        changes.push({ seatId: p.id, name: p.name, type: 'repay', amount: dR });
        this.bankLog.push({ seatId: p.id, name: p.name, type: 'repay', amount: dR, reason: '玩家自助', ts: Date.now() });
        this.log(`${p.name} 向牌池归还 ${dR} · 累计借 ${rec.borrowed} / 还 ${rec.repaid} · 净欠 ${Math.max(0, rec.borrowed - rec.repaid)}`, 'bank');
      }
    });
    if (changes.length) {
      this.syncLedger();
      this.emit('bankChange', { type: 'adopt', changes });
      this.emit('update');
    }
    return changes;
  }

  // 本手结束后：把输光的人自动补到起始筹码线
  autoRefillBusted() {
    if (!this.isAuthority) return [];
    const refilled = [];
    this.players.forEach(p => {
      if (p.empty || p.stack > 0) return;
      const rec = this.ledgerOf(p);
      if (!rec) return;
      rec.borrowed += this.autoBorrow;
      p.stack += this.autoBorrow;
      refilled.push({ seatId: p.id, name: p.name, amount: this.autoBorrow });
      this.bankLog.push({ seatId: p.id, name: p.name, type: 'borrow', amount: this.autoBorrow, reason: '输光自动补码', ts: Date.now() });
      this.log(`${p.name} 筹码归零，自动从牌池借入 ${this.autoBorrow} · 累计借 ${rec.borrowed} / 还 ${rec.repaid} · 净欠 ${Math.max(0, rec.borrowed - rec.repaid)}`, 'bank');
    });
    if (refilled.length) {
      this.syncLedger();
      this.emit('bankChange', { type: 'autoRefill', refilled });
      this.emit('update');
    }
    return refilled;
  }

  // 房主结算：净盈亏 = 当前筹码 - 初始买入 - 累计借入 + 累计归还
  settleTable() {
    this.syncLedger();
    const rows = this.players.filter(p => !p.empty).map(p => {
      // 兜底记录的 buyIn 同样必须是 0：填 startingStack 会凭空抵掉
      // 一笔借款，让净盈亏虚高，和 syncLedger 的建账口径保持一致。
      const rec = this.ledgerOf(p) || { borrowed: 0, repaid: 0, buyIn: 0 };
      const net = p.stack - rec.buyIn - rec.borrowed + rec.repaid;
      return {
        seatId: p.id,
        name: p.name,
        avatar: p.avatar,
        isAI: !!p.isAI,
        isHero: !!p.isHero,
        stack: p.stack,
        buyIn: rec.buyIn,
        borrowed: rec.borrowed,
        repaid: rec.repaid,
        debt: Math.max(0, rec.borrowed - rec.repaid),
        net
      };
    }).sort((a, b) => b.net - a.net);

    const totalNet = rows.reduce((s, r) => s + r.net, 0);
    const bankOut = rows.reduce((s, r) => s + r.borrowed - r.repaid, 0);
    const settlement = { rows, totalNet, bankOut, hands: this.handNo, ts: Date.now() };
    this.settlement = settlement;

    this.log('—— 本场结算 ——', 'stage');
    rows.forEach(r => {
      const tag = r.net > 0 ? `赢 ${r.net}` : r.net < 0 ? `输 ${Math.abs(r.net)}` : '不输不赢';
      this.log(`${r.name}：手上 ${r.stack} · 买入 ${r.buyIn} · 借 ${r.borrowed} · 还 ${r.repaid} → ${tag}`, r.net >= 0 ? 'win' : 'fold');
    });
    if (totalNet !== 0) {
      this.log(`校验：全场净盈亏合计 ${totalNet}（应为 0，非 0 说明有筹码未结清）`, 'warn');
    }

    this.emit('settled', settlement);
    this.emit('update');
    return settlement;
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
    // 构造阶段 initPlayers 早于 resetTableState，此时 logs 还不存在。
    // 建账日志会在那个时刻触发，所以这里必须自愈而不是直接崩。
    if (!Array.isArray(this.logs)) this.logs = [];
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
    // 清掉上一手的开牌确认状态与兜底定时器
    if (this.showdownTimer) clearTimeout(this.showdownTimer);
    this.showdownTimer = null;
    this.showdownCont = null;
    this.showdownReady = new Set();
    this.showdownDeadline = 0;

    this.players.forEach(p => {
      p.hole = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = p.empty || p.stack <= 0;
      p.allIn = false;
      p.acted = false;
      p.lastAction = p.empty ? '' : (p.stack <= 0 ? '淘汰' : '');
      p.showCards = false;
      p.revealedByChoice = false;
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

  // 玩家主动亮牌：弃牌后或本手结束后，自愿把底牌公开给全桌
  // showCards 一旦置真，序列化层就会下发真实牌面，UI 也会翻开，且不可撤回
  revealHole(playerId) {
    const p = this.players[playerId];
    if (!p || p.empty) return { ok: false, msg: '该座位不可亮牌' };
    if (!p.hole || p.hole.filter(Boolean).length < 2) return { ok: false, msg: '你手上没有底牌可亮' };
    if (p.showCards) return { ok: false, msg: '你已经亮过牌了' };
    // 只允许「已弃牌」或「本手已结束」两种时机，避免牌局进行中泄露信息
    const handOver = this.stage === 'over' || this.stage === 'showdown';
    if (!p.folded && !handOver) {
      return { ok: false, msg: '只能在弃牌后或本手结束后亮牌' };
    }
    p.showCards = true;
    p.revealedByChoice = true;
    // 公共牌够 3 张才算得出牌型，否则只亮牌面不评牌
    if (this.community.length >= 3) {
      p.eval = evaluateBest(p.hole.concat(this.community));
      this.log(`${p.name} 主动亮牌 ${p.hole.map(c => c.label + c.symbol).join(' ')} → ${describeEval(p.eval)}`, 'reveal');
    } else {
      this.log(`${p.name} 主动亮牌 ${p.hole.map(c => c.label + c.symbol).join(' ')}`, 'reveal');
    }
    this.emit('holeRevealed', { player: p });
    this.emit('update');
    return { ok: true };
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

    // 先只亮牌 + 打出各家牌型，让玩家有时间自己比较
    cont.forEach(p => this.log(`${p.name} 亮牌 ${p.hole.map(c => c.label + c.symbol).join(' ')} → ${describeEval(p.eval)}`, 'reveal'));
    this.emit('revealCards', { contenders: cont });
    this.emit('update');

    // 不再用固定停顿：等所有真人点「看好了」再结算，
    // 同时留一个兜底截止时间，避免有人挂机让全桌卡住
    this.showdownReady = new Set();
    this.showdownCont = cont;
    this.showdownDeadline = Date.now() + this.showdownMaxWait;
    this.emit('showdownPending', {
      ms: this.showdownMaxWait,
      deadline: this.showdownDeadline,
      contenders: cont,
      waiting: this.showdownWaiters()
    });
    this.emit('update');

    if (this.showdownTimer) clearTimeout(this.showdownTimer);
    this.showdownTimer = setTimeout(() => this.finishShowdown(true), this.showdownMaxWait);
    // 满桌都是 AI（无真人需要确认）时立即走原来的短停顿节奏
    this.maybeFinishShowdown();
  }

  // 需要点确认的座位：本手还在场、非 AI、非空位的真人
  showdownWaiters() {
    if (this.stage !== 'showdown') return [];
    return this.players
      .filter(p => !p.isAI && !p.empty && p.hole && p.hole.filter(Boolean).length >= 2)
      .filter(p => !this.showdownReady.has(p.id))
      .map(p => ({ id: p.id, name: p.name }));
  }

  // 某个座位点了「看好了」
  markShowdownReady(playerId) {
    if (this.stage !== 'showdown') return { ok: false, msg: '现在不是开牌阶段' };
    const p = this.players[playerId];
    if (!p || p.empty) return { ok: false, msg: '座位无效' };
    if (this.showdownReady.has(playerId)) return { ok: false, msg: '你已经确认过了' };
    this.showdownReady.add(playerId);
    this.log(`${p.name} 已看好牌`, 'stage');
    this.emit('showdownReadyChange', {
      readyIds: [...this.showdownReady],
      waiting: this.showdownWaiters(),
      deadline: this.showdownDeadline
    });
    this.emit('update');
    this.maybeFinishShowdown();
    return { ok: true };
  }

  // 全员确认后立刻结算；这里仍留一点点延迟让最后一次点击的反馈能画出来
  maybeFinishShowdown() {
    if (this.stage !== 'showdown') return;
    if (this.showdownWaiters().length > 0) return;
    if (this.showdownTimer) clearTimeout(this.showdownTimer);
    this.showdownTimer = setTimeout(() => this.finishShowdown(false), 400);
  }

  finishShowdown(byTimeout) {
    if (this.stage !== 'showdown') return;
    if (this.showdownTimer) clearTimeout(this.showdownTimer);
    this.showdownTimer = null;
    if (byTimeout) {
      const left = this.showdownWaiters();
      if (left.length) this.log(`等待超时，自动公布结果（${left.map(w => w.name).join('、')} 未确认）`, 'warn');
    }
    const cont = this.showdownCont || this.contenders();
    this.showdownCont = null;
    this.settleShowdown(cont);
  }

  settleShowdown(cont) {
    this.showdownReady = new Set();
    this.showdownDeadline = 0;
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
    // 输光不再淘汰：本手结束后自动从牌池借码补回起始线
    setTimeout(() => this.autoRefillBusted(), 600);
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
        // 已在座者保留筹码。输光的人这里必须保持 0，不能直接补到起始线，
        // 否则这 2000 绕过账本变成白送，随后 autoRefillBusted 也不会记账。
        // 补码统一交给 autoRefillBusted，确保每一笔都落到 borrowed 上。
        const known = prevByOwner.has(seat.owner);
        // 已在座者的带入欠款早已记进账本，座位上的 debt 是历史残留。
        // 必须清掉：否则一旦账本被重建，这笔债会被当成新的带入再记一次。
        if (known) return { ...seat, stack: old.stack || 0, debt: 0 };
        // 新入座者：座位上带了存档筹码就用它（同房间续打），否则给起始筹码
        const carried = seat.stack != null ? seat.stack : this.startingStack;
        return { ...seat, stack: carried };
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
