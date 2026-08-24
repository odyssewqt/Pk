// 战绩层：把结算单落库，以及查询自己的历史对局
//
// 数据来源就是 engine.settleTable() 产出的 settlement 对象，
// 其中每一行已经包含所需的全部字段：
//   buyIn    -> start_chips 起始筹码
//   stack    -> end_chips   结束筹码
//   borrowed / repaid / net -> 借贷与净盈亏
//   settlement.hands        -> 本场对局手数
//
// 写入只写「自己那一行」：RLS 规定 user_id 必须等于 auth.uid()，
// 所以房主不能替别人写。每个客户端各自把自己那行写进去，
// 这样既满足安全策略，也不需要额外的服务端。

import { authedFetch, currentUser, isLoggedIn } from './auth.js';

// 同一场结算只写一次，避免重复渲染或重连时写重复行
const written = new Set();

// 从结算单里挑出「我」那一行。
// 房主端 isHero 为真即本人；客机端靠座位号匹配更可靠。
function pickMyRow(settlement, mySeatId) {
  const rows = Array.isArray(settlement?.rows) ? settlement.rows : [];
  if (!rows.length) return null;
  if (mySeatId != null) {
    const bySeat = rows.find(r => r.seatId === mySeatId && !r.isAI);
    if (bySeat) return bySeat;
  }
  return rows.find(r => r.isHero && !r.isAI) || null;
}

// 落库自己的战绩。未登录、没有对应行、或已写过都会安静跳过。
export async function saveMyRecord(settlement, { roomCode, mySeatId }) {
  const user = currentUser();
  if (!user) return { ok: false, skipped: '未登录' };
  if (!settlement || !settlement.ts) return { ok: false, skipped: '无结算数据' };

  const key = `${user.id}_${roomCode}_${settlement.ts}`;
  if (written.has(key)) return { ok: false, skipped: '已写入' };

  const row = pickMyRow(settlement, mySeatId);
  if (!row) return { ok: false, skipped: '结算单里没有我' };

  // 先占位，防止同一场并发触发两次写入
  written.add(key);

  const payload = {
    user_id: user.id,
    room_code: roomCode || '',
    hands: Number(settlement.hands) || 0,
    start_chips: Number(row.buyIn) || 0,
    end_chips: Number(row.stack) || 0,
    borrowed: Number(row.borrowed) || 0,
    repaid: Number(row.repaid) || 0,
    net: Number(row.net) || 0,
    played_at: new Date(settlement.ts).toISOString()
  };

  try {
    const res = await authedFetch('/match_records', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify(payload)
    }, '保存战绩失败');

    if (!res.ok) {
      written.delete(key);
      const txt = await res.text();
      throw new Error(`保存战绩失败 ${res.status}: ${txt}`);
    }
    // 这一场的结束筹码就是该房间下次的带入筹码，缓存必须失效
    invalidateRoomCarry(payload.room_code);
    return { ok: true };
  } catch (err) {
    written.delete(key);
    console.error('[records] 写入失败', err);
    return { ok: false, msg: err.message };
  }
}

// ================= 按房间的筹码存档 =================
//
// 不新建表：match_records 里已经按 (user_id, room_code) 记了每场的
// end_chips，取该房间最近一场的结束筹码就是「下次带入的筹码」。
// RLS 只允许读自己的行，所以这里天然只能拿到自己的存档。

// 房间号 -> 带入筹码 的内存缓存，避免大厅里反复查同一个房间
const carryCache = new Map();

function normRoomCode(code) {
  return (code || '').trim().toUpperCase();
}

// 查这个房间我上次打完剩多少筹码。
// 返回 null 表示该房间没有我的记录（应按起始筹码入座）。
export async function fetchRoomCarry(roomCode) {
  const code = normRoomCode(roomCode);
  if (!code) return null;
  if (!isLoggedIn()) return null;
  if (carryCache.has(code)) return carryCache.get(code);

  try {
    const res = await authedFetch(
      `/match_records?select=end_chips,played_at&room_code=eq.${encodeURIComponent(code)}`
      + `&order=played_at.desc&limit=1`,
      {},
      '读取房间筹码失败'
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) {
      carryCache.set(code, null);
      return null;
    }
    const chips = Number(rows[0].end_chips);
    // 上次打到 0 也是有效存档（就是没钱了），只有非数字才当作无存档
    const val = Number.isFinite(chips) ? Math.max(0, Math.round(chips)) : null;
    carryCache.set(code, val);
    return val;
  } catch (err) {
    console.warn('[records] 查询房间筹码失败', err);
    return null;
  }
}

// 结算写库后，这个房间的存档就变了，清掉缓存让下次重新查
export function invalidateRoomCarry(roomCode) {
  const code = normRoomCode(roomCode);
  if (code) carryCache.delete(code);
  else carryCache.clear();
}

// 拉取自己的历史对局，按时间倒序
export async function fetchMyRecords(limit = 100) {
  const user = currentUser();
  if (!user) return [];
  const res = await authedFetch(
    `/match_records?select=*&order=played_at.desc&limit=${limit}`,
    {},
    '读取战绩失败'
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`读取战绩失败 ${res.status}: ${txt}`);
  }
  return await res.json();
}

// 由记录列表算出汇总指标，供战绩页顶部的卡片展示
export function summarize(list) {
  const rows = Array.isArray(list) ? list : [];
  const sessions = rows.length;
  const hands = rows.reduce((s, r) => s + (Number(r.hands) || 0), 0);
  const net = rows.reduce((s, r) => s + (Number(r.net) || 0), 0);
  const wins = rows.filter(r => (Number(r.net) || 0) > 0).length;
  const loses = rows.filter(r => (Number(r.net) || 0) < 0).length;
  const best = rows.reduce((m, r) => Math.max(m, Number(r.net) || 0), 0);
  const worst = rows.reduce((m, r) => Math.min(m, Number(r.net) || 0), 0);
  const winRate = sessions ? Math.round((wins / sessions) * 100) : 0;

  return { sessions, hands, net, wins, loses, best, worst, winRate };
}
