// 账号层：Supabase Auth（邮箱 + 密码）的纯 REST 封装
// 与 net.js 保持同一风格，不引入 supabase-js，避免额外依赖
//
// 会话（access_token / refresh_token）持久化在 localStorage，
// 刷新页面后自动恢复；token 过期时用 refresh_token 静默续期。

const SUPABASE_URL = 'https://sfuofpmhflohiwczifkd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmdW9mcG1oZmxvaGl3Y3ppZmtkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyNzY0NjIsImV4cCI6MjEwMjg1MjQ2Mn0.emmhFI34klNnlqRdRk47oRaIVTU3_udQRR0cgf0zOWo';

const AUTH = `${SUPABASE_URL}/auth/v1`;
const REST = `${SUPABASE_URL}/rest/v1`;
const SESSION_KEY = 'poker_session';

// 当前会话在内存里的镜像，避免每次读 localStorage
let sess = null;

// ---------- 会话读写 ----------

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.access_token || !s.user) return null;
    return s;
  } catch {
    return null;
  }
}

function saveSession(s) {
  sess = s;
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

// 把 Supabase 返回的 token 响应整理成本地会话结构
function normalize(data) {
  if (!data || !data.access_token) return null;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    // expires_at 用绝对毫秒时间戳，便于判断是否临近过期
    expires_at: Date.now() + (Number(data.expires_in || 3600) * 1000),
    user: data.user ? { id: data.user.id, email: data.user.email } : null
  };
}

export function currentUser() {
  if (!sess) sess = loadSession();
  return sess?.user || null;
}

export function isLoggedIn() {
  return !!currentUser();
}

// ---------- 请求辅助 ----------

async function safeFetch(url, options, label) {
  try {
    return await fetch(url, options);
  } catch (err) {
    console.error(`[auth] ${label} 网络层失败`, err);
    throw new Error(`${label}：请求没能发出，请检查网络或代理是否拦截了 supabase.co`);
  }
}

// 把 Supabase 的英文错误翻译成看得懂的中文
function translateError(status, body) {
  const msg = (body?.msg || body?.error_description || body?.message || body?.error || '').toString();
  const low = msg.toLowerCase();

  if (low.includes('invalid login credentials')) return '邮箱或密码不对';
  if (low.includes('email not confirmed')) return '这个邮箱还没验证。请到 Supabase 后台把 Confirm email 关掉，或去邮箱点验证链接';
  if (low.includes('user already registered') || low.includes('already been registered')) return '这个邮箱已经注册过了，直接登录就行';
  if (low.includes('password should be at least')) return '密码太短，至少 6 位';
  if (low.includes('unable to validate email') || low.includes('invalid email')) return '邮箱格式不对';
  if (low.includes('rate limit') || status === 429) return '操作太频繁，等一会儿再试';
  if (low.includes('signups not allowed')) return '该项目关闭了注册，请到 Supabase 后台开启 Email provider';
  if (status === 404) return '接口不存在，请确认 Supabase 项目的 Auth 服务正常';
  return msg || `请求失败（HTTP ${status}）`;
}

async function parseJSON(res) {
  const txt = await res.text();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return { message: txt }; }
}

// ---------- 注册 / 登录 / 登出 ----------

// 注册：成功后若直接返回 token（Confirm email 关闭时）就顺带登录
export async function signUp(email, password, nickname, avatar) {
  const res = await safeFetch(`${AUTH}/signup`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      // 昵称头像先塞到 user_metadata，建 profile 时再落到独立表
      data: { nickname: nickname || '玩家', avatar: avatar || '🙂' }
    })
  }, '注册请求发送失败');

  const data = await parseJSON(res);
  if (!res.ok) throw new Error(translateError(res.status, data));

  const s = normalize(data);
  if (s) {
    saveSession(s);
    // 注册即登录：补建 profile 行
    await upsertProfile(nickname, avatar).catch(e => console.warn('[auth] 建资料失败', e));
    return { ok: true, needVerify: false };
  }

  // 没拿到 token，说明开着邮箱验证
  return { ok: true, needVerify: true };
}

export async function signIn(email, password) {
  const res = await safeFetch(`${AUTH}/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  }, '登录请求发送失败');

  const data = await parseJSON(res);
  if (!res.ok) throw new Error(translateError(res.status, data));

  const s = normalize(data);
  if (!s) throw new Error('登录返回数据异常，没拿到凭证');
  saveSession(s);
  return s.user;
}

export async function signOut() {
  const token = sess?.access_token;
  saveSession(null);
  if (!token) return;
  // 通知服务端吊销，失败也无所谓，本地已清干净
  try {
    await fetch(`${AUTH}/logout`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}` }
    });
  } catch { /* 忽略 */ }
}

// ---------- token 续期 ----------

async function refresh() {
  const rt = sess?.refresh_token;
  if (!rt) return null;
  try {
    const res = await fetch(`${AUTH}/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt })
    });
    if (!res.ok) {
      // refresh_token 也失效了，只能重新登录
      saveSession(null);
      return null;
    }
    const s = normalize(await res.json());
    if (s) saveSession(s);
    return s;
  } catch (err) {
    console.warn('[auth] 续期失败', err);
    return null;
  }
}

// 取一个可用的 access_token；临近过期（剩不到 60 秒）就先续期
async function validToken() {
  if (!sess) sess = loadSession();
  if (!sess) return null;
  if (sess.expires_at && sess.expires_at - Date.now() < 60000) {
    const s = await refresh();
    return s?.access_token || null;
  }
  return sess.access_token;
}

// 带用户身份的 REST 请求：RLS 靠这个 token 判断 auth.uid()
// 遇到 401 自动续期重试一次，避免长时间挂着页面后一操作就失败
export async function authedFetch(path, options = {}, label = '请求') {
  let token = await validToken();
  if (!token) throw new Error('登录状态已过期，请重新登录');

  const build = t => ({
    ...options,
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${t}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  let res = await safeFetch(`${REST}${path}`, build(token), label);
  if (res.status === 401) {
    const s = await refresh();
    if (!s) throw new Error('登录状态已过期，请重新登录');
    res = await safeFetch(`${REST}${path}`, build(s.access_token), label);
  }
  return res;
}

// ---------- 用户资料 ----------

// 写入或更新自己的昵称头像（主键冲突时合并）
export async function upsertProfile(nickname, avatar) {
  const user = currentUser();
  if (!user) return null;
  const res = await authedFetch('/profiles?on_conflict=id', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      id: user.id,
      nickname: nickname || '玩家',
      avatar: avatar || '🙂'
    })
  }, '保存资料失败');
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`保存资料失败 ${res.status}: ${t}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

export async function fetchProfile() {
  const user = currentUser();
  if (!user) return null;
  const res = await authedFetch(`/profiles?id=eq.${user.id}&select=*`, {}, '读取资料失败');
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}
