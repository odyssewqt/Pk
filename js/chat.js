// 聊天模块：消息存在房间共享状态的 chat 数组里，借助 CAS 合并，
// 房主和客机走完全相同的写入路径，谁掉线都不影响其他人发言。
import { mutateRoomState } from './net.js';

export const MAX_CHAT = 60;
const EMOJIS = ['😀', '😂', '😎', '🤔', '😭', '😡', '👍', '👎', '🎉', '🔥', '💰', '🃏', '♠', '♥', '♣', '♦', '🙏', '💪', '😱', '🤯', '🥶', '🤡'];

// 快捷短语：牌桌上最常说的几句，点一下就发，省得打字
const QUICK = ['好牌！', '过过过', '你诈唬吧？', '这把我弃了', '再来一把', '手气真差', '大佬带我', '慢一点'];

let sendImpl = null;
let localEcho = null;

// 由 main.js 注入发送通道与本地回显，chat 模块不直接依赖 session
export function initChat({ send, echo } = {}) {
  sendImpl = typeof send === 'function' ? send : null;
  localEcho = typeof echo === 'function' ? echo : null;
}

// 生成消息唯一 id，用于去重与 key
function newMsgId(seatId) {
  return `m_${seatId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function makeMessage({ seatId, name, owner, text, kind = 'text' }) {
  const body = String(text == null ? '' : text).slice(0, 120);
  return {
    id: newMsgId(seatId),
    seatId: seatId == null ? -1 : seatId,
    name: name || '旁观者',
    owner: owner || null,
    text: body,
    kind,
    ts: Date.now()
  };
}

// 把消息合并进房间状态：只追加，并裁掉过老的，避免 jsonb 无限增长
export function appendChatToState(state, msg) {
  const list = Array.isArray(state.chat) ? state.chat.slice() : [];
  if (list.some(m => m && m.id === msg.id)) return list;
  list.push(msg);
  return list.slice(-MAX_CHAT);
}

// 发送：走 CAS 读-改-写，和借还筹码同一套并发保护
export async function sendChat(code, msg) {
  if (!code) return { ok: false, msg: '未在房间中' };
  if (localEcho) localEcho(msg);
  try {
    const res = await mutateRoomState(code, cur => {
      cur.chat = appendChatToState(cur, msg);
      return cur;
    });
    return res.ok ? { ok: true } : { ok: false, msg: res.msg || '发送失败' };
  } catch (err) {
    console.error('[chat] 发送失败', err);
    return { ok: false, msg: err.message || '发送失败' };
  }
}

export function getEmojis() { return EMOJIS.slice(); }
export function getQuickPhrases() { return QUICK.slice(); }
export function getSendImpl() { return sendImpl; }
