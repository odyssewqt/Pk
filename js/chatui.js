// 聊天面板渲染：消息列表、表情选择、快捷短语
import { getEmojis, getQuickPhrases, MAX_CHAT } from './chat.js';

const $ = id => document.getElementById(id);

let onSend = null;
let rendered = [];
let pickerOpen = false;

// HTML 转义：消息是玩家自由输入，必须防止注入
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timeLabel(ts) {
  const d = new Date(ts || Date.now());
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// 纯表情消息放大显示，读起来更有牌桌氛围
function isEmojiOnly(text) {
  if (!text) return false;
  const stripped = text.replace(/[\s\u200d\ufe0f]/g, '');
  if (!stripped) return false;
  return [...stripped].length <= 3 && !/[0-9a-zA-Z\u4e00-\u9fa5]/.test(stripped);
}

function seatColor(seatId) {
  const palette = ['text-amber-300', 'text-sky-300', 'text-emerald-300', 'text-violet-300', 'text-rose-300', 'text-teal-300'];
  const i = Number(seatId);
  if (!Number.isFinite(i) || i < 0) return 'text-slate-400';
  return palette[i % palette.length];
}

function msgRow(m, mine) {
  const big = isEmojiOnly(m.text);
  if (m.kind === 'system') {
    return `<div class="text-center text-[11px] text-slate-500 py-0.5">${esc(m.text)}</div>`;
  }
  const align = mine ? 'items-end' : 'items-start';
  const bubble = mine
    ? 'bg-emerald-600/80 text-white rounded-br-sm'
    : 'bg-white/10 text-slate-100 rounded-bl-sm';
  return `
    <div class="flex flex-col ${align} gap-0.5" data-mid="${esc(m.id)}">
      <div class="flex items-center gap-1.5 text-[10px] ${mine ? 'flex-row-reverse' : ''}">
        <span class="font-bold ${mine ? 'text-emerald-300' : seatColor(m.seatId)}">${esc(m.name)}</span>
        <span class="text-slate-500">${timeLabel(m.ts)}</span>
      </div>
      <div class="max-w-[85%] px-2.5 py-1.5 rounded-2xl ${bubble} ${big ? 'text-2xl leading-none' : 'text-xs leading-relaxed'} break-words whitespace-pre-wrap">${esc(m.text)}</div>
    </div>`;
}

export function renderChat(list, mySeatId, myOwner) {
  const box = $('chatList');
  if (!box) return;
  const msgs = (Array.isArray(list) ? list : []).slice(-MAX_CHAT);
  // 内容未变化就不重绘，避免打断用户滚动与选择
  const sig = msgs.map(m => m && m.id).join('|');
  if (sig === rendered.join('|')) return;
  rendered = msgs.map(m => m && m.id);

  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  if (!msgs.length) {
    box.innerHTML = `<div class="h-full flex flex-col items-center justify-center text-center text-[11px] text-slate-500 gap-1 py-6">
      <i class="ri-chat-smile-2-line text-2xl text-slate-600"></i>
      <p>还没有人说话，打个招呼吧</p>
    </div>`;
    return;
  }
  box.innerHTML = msgs.map(m => {
    const mine = (myOwner && m.owner && m.owner === myOwner) || (m.owner == null && m.seatId === mySeatId);
    return msgRow(m, mine);
  }).join('');
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

// 未读红点：面板在视口外或折叠时提示有新消息
export function setChatUnread(n) {
  const dot = $('chatUnread');
  if (!dot) return;
  if (n > 0) {
    dot.textContent = n > 99 ? '99+' : String(n);
    dot.classList.remove('hidden');
  } else {
    dot.classList.add('hidden');
  }
}

function buildPicker() {
  const wrap = $('chatEmojiPicker');
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="grid grid-cols-8 gap-1 p-2">
      ${getEmojis().map(e => `<button type="button" data-emoji="${e}" class="w-7 h-7 rounded hover:bg-white/15 transition text-lg leading-none flex items-center justify-center">${e}</button>`).join('')}
    </div>
    <div class="border-t border-white/10 p-2 flex flex-wrap gap-1">
      ${getQuickPhrases().map(q => `<button type="button" data-phrase="${esc(q)}" class="px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition text-[11px]">${esc(q)}</button>`).join('')}
    </div>`;
}

function togglePicker(force) {
  const wrap = $('chatEmojiPicker');
  if (!wrap) return;
  pickerOpen = typeof force === 'boolean' ? force : !pickerOpen;
  wrap.classList.toggle('hidden', !pickerOpen);
}

function submit() {
  const input = $('chatInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  togglePicker(false);
  if (onSend) onSend(text);
}

// 事件全部委托绑定，HTML 里不写任何 on* 属性
export function bindChatUI(handler) {
  onSend = handler;
  buildPicker();

  const form = $('chatForm');
  if (form) {
    form.addEventListener('submit', ev => { ev.preventDefault(); submit(); });
  }
  const btnEmoji = $('btnChatEmoji');
  if (btnEmoji) btnEmoji.addEventListener('click', () => togglePicker());

  const picker = $('chatEmojiPicker');
  if (picker) {
    picker.addEventListener('click', ev => {
      const eBtn = ev.target.closest('[data-emoji]');
      const pBtn = ev.target.closest('[data-phrase]');
      const input = $('chatInput');
      if (eBtn && input) {
        input.value = (input.value + eBtn.dataset.emoji).slice(0, 120);
        input.focus();
        return;
      }
      if (pBtn && onSend) {
        togglePicker(false);
        onSend(pBtn.dataset.phrase);
      }
    });
  }

  // 输入框回车发送，Shift+Enter 不换行（单行输入，保持简单）
  const input = $('chatInput');
  if (input) {
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit(); }
    });
  }

  // 点击面板外关闭表情盘
  document.addEventListener('click', ev => {
    if (!pickerOpen) return;
    if (ev.target.closest('#chatEmojiPicker') || ev.target.closest('#btnChatEmoji')) return;
    togglePicker(false);
  });
}

export function setChatEnabled(enabled, hint) {
  const input = $('chatInput');
  const send = $('btnChatSend');
  const emoji = $('btnChatEmoji');
  [input, send, emoji].forEach(el => { if (el) el.disabled = !enabled; });
  if (input) input.placeholder = enabled ? '说点什么…（回车发送）' : (hint || '进入房间后可聊天');
  const box = $('chatPanel');
  if (box) box.classList.toggle('opacity-60', !enabled);
}
