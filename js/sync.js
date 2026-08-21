// 状态序列化：把引擎状态压成可写入 jsonb 的纯数据，以及反向恢复
// 房主写全量状态；客机只读不算

// 房主写入的状态里，未开牌玩家的底牌需要遮罩，否则任何人按 F12 就能看到
// 只有 showCards（开牌阶段）或该牌属于接收者本人时才下发真实牌面
function maskedHole(p, revealAll) {
  if (!p.hole || !p.hole.length) return [];
  if (revealAll || p.showCards) return p.hole.map(cardToJSON);
  return p.hole.map(() => ({ hidden: true }));
}

export function serializeGame(game, room) {
  return {
    v: (room?.v || 0) + 1,
    phase: room?.phase || 'playing',
    seats: room.seats,
    handNo: game.handNo,
    stage: game.stage,
    pot: game.pot,
    currentBet: game.currentBet,
    minRaise: game.minRaise,
    bigBlind: game.bigBlind,
    smallBlind: game.smallBlind,
    dealerIndex: game.dealerIndex,
    activeIndex: game.activeIndex,
    community: game.community.map(cardToJSON),
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      style: p.style,
      desc: p.desc,
      seatOwner: p.seatOwner || null,
      isAI: !!p.isAI,
      stack: p.stack,
      bet: p.bet,
      totalBet: p.totalBet,
      folded: p.folded,
      allIn: p.allIn,
      acted: p.acted,
      lastAction: p.lastAction,
      showCards: p.showCards,
      winAmount: p.winAmount,
      hole: maskedHole(p, false),
      // 每个座位的真实底牌单独放一份，按 owner 分发
      holeFor: p.seatOwner ? { owner: p.seatOwner, cards: p.hole.map(cardToJSON) } : null,
      evalName: p.eval ? p.eval.name : null
    })),
    results: game.results ? {
      winners: game.results.winners.map(w => ({
        id: w.player.id, name: w.player.name, amount: w.amount, evalName: w.evalName
      }))
    } : null,
    logs: game.logs.slice(-40),
    action: null,
    ts: Date.now()
  };
}

function cardToJSON(c) {
  if (!c) return null;
  return { suit: c.suit, symbol: c.symbol, color: c.color, value: c.value, label: c.label, id: c.id };
}

// 客机侧：把远端状态套进一个只用于渲染的假 game 对象
// 注意：这是信任局。holeFor 里带着所有座位的真实底牌，
// 打开控制台读 room.state 就能看到别人的牌。UI 层不显示，但技术上防不住。
// 真正的隔离需要把发牌搬到 Postgres 函数里，用 RLS 限制每人只能查自己那两张。
export function buildViewModel(state, mySeatId, myClientId) {
  const players = (state.players || []).map(p => {
    const mine = p.id === mySeatId;
    let hole;
    if (p.showCards && p.holeFor) {
      hole = p.holeFor.cards.filter(Boolean);
    } else if (mine && p.holeFor && p.holeFor.owner === myClientId) {
      hole = p.holeFor.cards.filter(Boolean);
    } else if (p.showCards) {
      hole = (p.hole || []).filter(c => c && !c.hidden);
    } else {
      // 只保留张数，不给牌面，让 UI 画牌背
      hole = (p.hole || []).map(() => null).filter(() => true);
    }
    return {
      ...p,
      isHero: mine,
      hole,
      eval: p.evalName ? { name: p.evalName } : null
    };
  });

  return {
    handNo: state.handNo,
    stage: state.stage,
    pot: state.pot,
    currentBet: state.currentBet,
    minRaise: state.minRaise,
    bigBlind: state.bigBlind,
    smallBlind: state.smallBlind,
    dealerIndex: state.dealerIndex,
    activeIndex: state.activeIndex,
    community: (state.community || []).filter(Boolean),
    players,
    results: state.results,
    logs: state.logs || [],
    record: { hands: 0, wins: 0, losses: 0, biggestPot: 0 },
    contenders() { return this.players.filter(p => !p.folded); },
    livePlayers() { return this.players.filter(p => !p.folded); }
  };
}

// 客机侧：从远端状态推导自己的可选操作
export function deriveOptions(state, mySeatId) {
  const me = (state.players || []).find(p => p.id === mySeatId);
  if (!me) return null;
  const toCall = Math.max(0, state.currentBet - me.bet);
  const maxRaiseTotal = me.bet + me.stack;
  const minRaiseTotal = Math.min(maxRaiseTotal, Math.max(state.currentBet + state.minRaise, state.bigBlind));
  return {
    toCall: Math.min(toCall, me.stack),
    canCheck: toCall === 0,
    canRaise: maxRaiseTotal > state.currentBet,
    minRaiseTotal,
    maxRaiseTotal,
    pot: state.pot,
    stack: me.stack
  };
}
