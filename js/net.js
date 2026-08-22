// 联机同步层：Supabase Realtime 封装
// 房主为唯一权威端，负责推进游戏并写入完整状态；客机订阅状态并回传动作

const SUPABASE_URL = 'https://sfuofpmhflohiwczifkd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmdW9mcG1oZmxvaGl3Y3ppZmtkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyNzY0NjIsImV4cCI6MjEwMjg1MjQ2Mn0.emmhFI34klNnlqRdRk47oRaIVTU3_udQRR0cgf0zOWo';

const REST = `${SUPABASE_URL}/rest/v1`;

const HEADERS = {
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json'
};

// 生成本客户端唯一标识，存 localStorage 以便刷新后仍是同一人
export function getClientId() {
  let id = localStorage.getItem('poker_client_id');
  if (!id) {
    id = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    localStorage.setItem('poker_client_id', id);
  }
  return id;
}

export function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ---------- REST 操作 ----------

// 统一包一层 fetch：把浏览器层面的 "Failed to fetch" 翻译成看得懂的原因
async function safeFetch(url, options, label) {
  try {
    return await fetch(url, options);
  } catch (err) {
    console.error(`[net] ${label} 网络层失败`, err);
    const isHttpPage = location.protocol === 'http:';
    let reason = '浏览器没能把请求发出去，通常是以下原因之一：';
    reason += '① 网络/代理拦截了 supabase.co；';
    reason += '② 浏览器插件（广告拦截、隐私保护）拦下了请求；';
    if (isHttpPage) reason += '③ 当前页面是 http，混合内容被拦截，请用 https 打开；';
    reason += '④ 该 Supabase 项目已被暂停或删除。';
    throw new Error(`${label}：${reason}（控制台 Network 面板可看到具体报错）`);
  }
}

export async function createRoom(code, hostId, state) {
  const res = await safeFetch(`${REST}/rooms`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'return=representation' },
    body: JSON.stringify({ code, host_id: hostId, state })
  }, '建房请求发送失败');
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`建房失败 ${res.status}: ${txt}`);
  }
  const rows = await res.json();
  return rows[0];
}

export async function fetchRoom(code) {
  const res = await safeFetch(`${REST}/rooms?code=eq.${encodeURIComponent(code)}&select=*`, {
    headers: HEADERS
  }, '查询房间请求发送失败');
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`读取房间失败 ${res.status}: ${txt}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

export async function updateRoomState(code, state) {
  const res = await safeFetch(`${REST}/rooms?code=eq.${encodeURIComponent(code)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ state, updated_at: new Date().toISOString() })
  }, '同步状态请求发送失败');
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`写入状态失败 ${res.status}: ${txt}`);
  }
  return true;
}

// 条件写入：只有当数据库里的 state->>'v' 仍等于 expectedV 时才写成功。
// 这是乐观并发控制（CAS）。原来的 updateRoomState 是无条件整行覆盖，
// 多人同时写会互相把对方的数据抹掉；加上这个条件后，
// 抢输的一方会拿到 0 行更新，从而知道要重新读取并合并再试。
export async function casRoomState(code, state, expectedV) {
  const url = `${REST}/rooms?code=eq.${encodeURIComponent(code)}`
    + `&state->>v=eq.${encodeURIComponent(String(expectedV))}`;
  const res = await safeFetch(url, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=representation' },
    body: JSON.stringify({ state, updated_at: new Date().toISOString() })
  }, '同步状态请求发送失败');
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`写入状态失败 ${res.status}: ${txt}`);
  }
  const rows = await res.json();
  // 返回 0 行 = 版本已被别人改掉，本次写入未生效
  return Array.isArray(rows) && rows.length > 0;
}

// 读-改-写重试：把 mutate 的修改安全地合入最新状态。
// mutate(state) 收到的是数据库里的最新状态，返回修改后的状态。
// 冲突时自动重读重试，因此并发的借还请求不会再互相覆盖或丢失。
export async function mutateRoomState(code, mutate, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    const row = await fetchRoom(code);
    if (!row || !row.state) throw new Error('房间不存在或状态为空');
    const cur = row.state;
    const expectedV = cur.v || 0;
    const next = mutate({ ...cur });
    if (!next) return { ok: true, state: cur, skipped: true };
    // 兜底：pv 是版本校验的依据，任何写入都不能把它丢掉，
    // 否则会被其他客户端误判成「版本不一致」而集体卡住。
    if (next.pv == null && cur.pv != null) next.pv = cur.pv;
    next.v = expectedV + 1;
    next.ts = Date.now();
    const won = await casRoomState(code, next, expectedV);
    if (won) return { ok: true, state: next };
    // 输给了并发写入，退避后重读最新状态再合并
    await new Promise(r => setTimeout(r, 60 + Math.random() * 140 + i * 60));
  }
  return { ok: false, msg: '并发冲突，请重试' };
}

// 自检：确认后端可达，返回 true/false 并在控制台打印详情
export async function checkBackend() {
  try {
    const res = await fetch(`${REST}/rooms?select=code&limit=1`, { headers: HEADERS });
    console.log('[net] 后端自检 HTTP', res.status);
    return res.ok;
  } catch (err) {
    console.error('[net] 后端自检失败，请求未能发出', err);
    return false;
  }
}

// ---------- Realtime 订阅 ----------
// 直接使用 Supabase Realtime 的 websocket 协议，不引入 supabase-js
// 避免额外依赖，同时便于把连接过程的每一步都打到控制台

const REALTIME_URL = SUPABASE_URL.replace('https://', 'wss://')
  + `/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;

export class RoomChannel {
  constructor(code, handlers = {}) {
    this.code = code;
    this.handlers = handlers;
    this.ws = null;
    this.ref = 0;
    this.joinedTopic = `realtime:room_${code}`;
    this.heartbeatTimer = null;
    this.closedByUser = false;
    this.retry = 0;
  }

  log(...args) {
    console.log('[realtime]', ...args);
  }

  connect() {
    this.closedByUser = false;
    this.log('正在连接', REALTIME_URL.split('?')[0]);
    this.ws = new WebSocket(REALTIME_URL);

    this.ws.onopen = () => {
      this.log('websocket 已打开，发送 join');
      this.retry = 0;
      this.sendJoin();
      this.startHeartbeat();
      this.handlers.onStatus?.('connected');
    };

    this.ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.handleMessage(msg);
    };

    this.ws.onerror = err => {
      console.error('[realtime] websocket 错误', err);
      this.handlers.onStatus?.('error');
    };

    this.ws.onclose = ev => {
      this.log('websocket 关闭', ev.code, ev.reason);
      this.stopHeartbeat();
      this.handlers.onStatus?.('closed');
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    this.retry++;
    const delay = Math.min(8000, 1000 * this.retry);
    this.log(`将在 ${delay}ms 后重连（第 ${this.retry} 次）`);
    setTimeout(() => { if (!this.closedByUser) this.connect(); }, delay);
  }

  nextRef() { return String(++this.ref); }

  sendJoin() {
    // 订阅 rooms 表中本房间那一行的 UPDATE 事件
    const payload = {
      config: {
        broadcast: { self: false },
        presence: { key: '' },
        postgres_changes: [
          { event: '*', schema: 'public', table: 'rooms', filter: `code=eq.${this.code}` }
        ]
      }
    };
    this.push(this.joinedTopic, 'phx_join', payload);
  }

  push(topic, event, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ topic, event, payload, ref: this.nextRef() }));
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.push('phoenix', 'heartbeat', {});
    }, 25000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  handleMessage(msg) {
    const { event, payload, topic } = msg;

    if (event === 'phx_reply' && topic === this.joinedTopic) {
      if (payload?.status === 'ok') {
        this.log('频道 join 成功，等待数据库订阅确认', payload.response);
        this.handlers.onStatus?.('joined');
      } else {
        console.error('[realtime] 频道订阅被拒绝', payload);
        this.handlers.onStatus?.('subscribe_failed');
      }
      return;
    }

    if (event === 'postgres_changes') {
      const data = payload?.data;
      if (!data) return;
      const row = data.record || data.new;
      if (row && row.code === this.code) {
        this.log('收到状态更新', data.type);
        this.handlers.onState?.(row);
      }
      return;
    }

    if (event === 'system') {
      this.log('系统消息', payload?.status, payload?.message);
      // 只有收到这条才代表数据库变更真的会被推过来
      if (payload?.status === 'ok' && /Subscribed to PostgreSQL/i.test(payload?.message || '')) {
        this.handlers.onStatus?.('subscribed');
      } else if (payload?.status === 'error') {
        this.handlers.onStatus?.('system_error');
      }
    }
  }

  close() {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.ws) this.ws.close();
  }
}
