// AI 决策：基于胜率估算 + 风格参数 + 诈唬倾向
import { estimateEquity, preflopStrength } from './poker.js';

const STYLE_PARAMS = {
  tight: { callThreshold: 0.52, raiseThreshold: 0.68, bluffRate: 0.06, aggression: 1.35, sizing: 0.85 },
  loose: { callThreshold: 0.32, raiseThreshold: 0.50, bluffRate: 0.28, aggression: 1.15, sizing: 0.65 },
  balanced: { callThreshold: 0.42, raiseThreshold: 0.58, bluffRate: 0.14, aggression: 1.0, sizing: 0.72 }
};

const SPEECH = {
  fold: ['算了，这手不玩', '让给你', '牌太烂了', '我出局'],
  check: ['过', '看一张', '不加'],
  call: ['跟你', '我陪你玩', '跟'],
  raise: ['加一点', '我看你敢不敢', '压力给到你', '加注'],
  allin: ['全下！', '梭哈！', '我全押了'],
  bluff: ['你信吗？', '试试看', '我这手很强哦']
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export function decideAction(ctx) {
  const { player, game, community, currentBet, pot, minRaise, opponents } = ctx;
  const params = STYLE_PARAMS[player.style] || STYLE_PARAMS.balanced;
  const toCall = Math.max(0, currentBet - player.bet);

  let equity;
  if (community.length === 0) {
    equity = 0.2 + preflopStrength(player.hole) * 0.65;
  } else {
    const iters = community.length >= 4 ? 900 : 600;
    equity = estimateEquity(player.hole, community, Math.max(1, opponents), iters);
  }

  // 随机性扰动，避免可预测
  const noise = (Math.random() - 0.5) * 0.08;
  const adjusted = Math.max(0, Math.min(1, equity + noise));

  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
  const bluffing = Math.random() < params.bluffRate;
  const stack = player.stack;

  // 无需跟注（可过牌）
  if (toCall === 0) {
    const betTrigger = adjusted > params.raiseThreshold || (bluffing && adjusted > 0.28);
    if (betTrigger && stack > 0) {
      const factor = (0.45 + adjusted * 0.65) * params.sizing * params.aggression;
      let target = player.bet + Math.round(Math.max(game.bigBlind, pot * factor));
      target = Math.min(target, player.bet + stack);
      if (adjusted > 0.9 && Math.random() < 0.35) {
        return { action: 'allin', amount: 0, speech: pick(SPEECH.allin) };
      }
      return { action: 'raise', amount: target, speech: bluffing && adjusted < 0.5 ? pick(SPEECH.bluff) : pick(SPEECH.raise) };
    }
    return { action: 'check', amount: 0, speech: pick(SPEECH.check) };
  }

  // 需要跟注
  const allInCost = toCall >= stack;

  if (adjusted > params.raiseThreshold + 0.08 && !allInCost) {
    if (adjusted > 0.88 && Math.random() < 0.4) {
      return { action: 'allin', amount: 0, speech: pick(SPEECH.allin) };
    }
    const factor = (0.6 + adjusted * 0.8) * params.sizing * params.aggression;
    let target = currentBet + Math.round(Math.max(minRaise, pot * factor * 0.5));
    target = Math.min(target, player.bet + stack);
    return { action: 'raise', amount: target, speech: pick(SPEECH.raise) };
  }

  if (bluffing && adjusted < params.callThreshold && !allInCost && Math.random() < 0.5) {
    const target = Math.min(currentBet + minRaise * 2, player.bet + stack);
    return { action: 'raise', amount: target, speech: pick(SPEECH.bluff) };
  }

  if (adjusted >= params.callThreshold || adjusted > potOdds + 0.06) {
    if (allInCost && adjusted < params.callThreshold + 0.1) {
      return { action: 'fold', amount: 0, speech: pick(SPEECH.fold) };
    }
    return { action: 'call', amount: 0, speech: pick(SPEECH.call) };
  }

  // 便宜的跟注仍可考虑
  if (toCall <= game.bigBlind && adjusted > 0.24 && Math.random() < 0.6) {
    return { action: 'call', amount: 0, speech: pick(SPEECH.call) };
  }

  return { action: 'fold', amount: 0, speech: pick(SPEECH.fold) };
}
