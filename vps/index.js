// iLink 微信云端问答机器人 — v4「极简版」（Pterodactyl 容器 / Node 22+ / 零依赖）
// 设计目标：400MB 内存里稳定跑。没有 Python、没有 uv、没有任何安装步骤，只有 Node + 网络。
//   ① 您问什么新闻 → GDELT + Google News 实时搜 → AI 整理 → 回微信
//   ② 发「日报」 → 默认关键词组聚合一份要闻（同样零安装，30-60 秒）
//   ③ 其他闲聊 → AI 直接回
// 部署：只传本文件到 /home/container/ → 面板 Restart。自检：node index.js --selftest 黄金
(function loadSecrets() {
  const fs = require('fs');
  const f = process.env.WXBOT_SECRETS || '/home/container/.secrets';
  try {
    for (const ln of fs.readFileSync(f, 'utf8').split('\n')) {
      const i = ln.indexOf('='); if (i < 1) continue;
      const k = ln.slice(0, i).trim(), v = ln.slice(i + 1).trim();
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch (e) { console.log('[secrets] 未读到 .secrets：' + e.message); }
})();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 'v4-simple';
// ── iLink 协议常量（与本地 Hermes weixin.py 对齐）──
const ILINK_APP_ID = 'bot';
const ILINK_CHANNEL_VERSION = '2.2.0';
const ILINK_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0);
const LONG_POLL_TIMEOUT_MS = 35000;
const API_TIMEOUT_MS = 15000;
const MAX_FAILS = 3, RETRY_DELAY_MS = 2000, BACKOFF_DELAY_MS = 30000;
const SESSION_EXPIRED = -14, RATE_LIMIT = -2;
const SPLIT_THRESHOLD = 1800;

function env(name, dft) { const v = process.env[name]; return (v && v.trim()) ? v : dft; }
const BASE_URL = env('WEIXIN_BASE_URL', 'https://ilinkai.weixin.qq.com').replace(/\/$/, '');
const ACCOUNT_ID = env('WEIXIN_ACCOUNT_ID', '');
const ALLOWED = env('WEIXIN_ALLOWED_USERS', '').split(',').map(s => s.trim()).filter(Boolean);
const AGNES_BASE = env('AGNES_API_BASE', 'https://apihub.agnes-ai.com/v1').replace(/\/$/, '');
const AGNES_MODEL = env('AGNES_MODEL', 'agnes-3.0-flash');
const AGNES_KEY = env('AGNES_API_KEY', '');
const STATE_DIR = env('WXBOT_STATE_DIR', '/home/container/state');
const SECRETS_FILE = env('WXBOT_SECRETS', '/home/container/.secrets');
const AI_TIMEOUT_MS = Number(env('WXBOT_AI_TIMEOUT_MS', '60000'));
const MAX_ITEMS = 8, AI_ITEM_CAP = 12, DAILY_MAX = 15;
const HONOR = '用户是"乐哥"，你每次回复必须以"乐哥 "（带空格）开头，全程尊称"您"，风格干脆简洁。';

fs.mkdirSync(STATE_DIR, { recursive: true });
try { fs.chmodSync(SECRETS_FILE, 0o600); } catch {}
const log = (lvl, m) => console.log(`[${new Date().toISOString()}] ${lvl} ${m}`);

let TOKEN = env('WEIXIN_TOKEN', '');
const syncBufFile = path.join(STATE_DIR, ACCOUNT_ID + '.sync.json');
const ctxFile = path.join(STATE_DIR, ACCOUNT_ID + '.ctx.json');
const loadJson = (f, dft) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dft; } };
const saveJson = (f, v) => { const t = f + '.tmp' + process.pid; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
let syncBuf = (loadJson(syncBufFile, {}) || {}).buf || '';
let ctxTokens = loadJson(ctxFile, {}) || {};
const clientId = 'wxbot-' + crypto.randomBytes(8).toString('hex');

function hdrs() {
  const uin = Buffer.from(String(parseInt(crypto.randomBytes(4).toString('hex'), 16))).toString('base64');
  const h = {
    'Content-Type': 'application/json', 'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': uin,
    'iLink-App-Id': ILINK_APP_ID, 'iLink-App-ClientVersion': ILINK_CLIENT_VERSION,
  };
  if (TOKEN) h['Authorization'] = 'Bearer ' + TOKEN;
  return h;
}
async function apiPost(endpoint, payload, token, timeoutMs) {
  const body = JSON.stringify({ ...payload, base_info: { channel_version: ILINK_CHANNEL_VERSION } });
  const h = hdrs(); if (token) h['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE_URL + '/' + endpoint, { method: 'POST', headers: h, body, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error('iLink ' + endpoint + ' HTTP ' + r.status);
  return r.json();
}
async function apiGet(endpoint, token, timeoutMs) {
  const h = hdrs(); if (token) h['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE_URL + '/' + endpoint, { headers: h, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error('iLink GET HTTP ' + r.status);
  return r.json();
}
const getUpdates = (buf, token, timeoutMs) => apiPost('ilink/bot/getupdates', { get_updates_buf: buf }, token, timeoutMs || LONG_POLL_TIMEOUT_MS);

function buildOutbound(to, text, ctx, msgClientId) {
  const msg = { from_user_id: '', to_user_id: to, client_id: msgClientId, message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text } }] };
  if (ctx) msg.context_token = ctx;
  return msg;
}
function newClientId() { return 'wxbot-' + crypto.randomUUID().replace(/-/g, ''); }
function isStaleRet(r) {
  const ret = r && (r.ret ?? r.errcode), em = String((r && (r.errmsg || r.msg)) || '').toLowerCase();
  return ret === SESSION_EXPIRED || (ret === RATE_LIMIT && (em === 'unknown error' || em === 'prepare failed'));
}
async function sendText(to, text, ctx) {
  let retried = false;
  for (let i = 0; i < 2; i++) {
    const r = await apiPost('ilink/bot/sendmessage', { msg: buildOutbound(to, text, retried ? null : ctx, newClientId()) }, TOKEN, API_TIMEOUT_MS);
    const ret = r && (r.ret ?? r.errcode ?? 0);
    if (ret === 0 || ret === undefined) { log('INFO', `send len=${String(text).length} ret=${ret}`); return r; }
    if (isStaleRet(r) && !retried && ctx) {
      retried = true;
      ctxTokens[to] = null; saveJson(ctxFile, ctxTokens);
      log('WARN', `send stale ret=${ret} ${r.errmsg || ''} → retry without context_token`);
      continue;
    }
    log('WARN', `send FAIL len=${String(text).length} ret=${ret} errmsg=${r.errmsg || r.msg || ''}`);
    return r;
  }
  return null;
}
async function sendChunks(to, text, ctx) {
  for (const c of chunkText(text)) { await sendText(to, c, ctx); await new Promise(r => setTimeout(r, 1200)); }
}
function chunkText(text) {
  const t = String(text); if (t.length <= SPLIT_THRESHOLD) return [t];
  const chunks = []; const paras = t.split('\n'); let cur = '';
  for (const p of paras) {
    if ((cur + '\n' + p).length > SPLIT_THRESHOLD && cur) { chunks.push(cur); cur = p; } else cur = cur ? cur + '\n' + p : p;
    while (cur.length > SPLIT_THRESHOLD) { chunks.push(cur.slice(0, SPLIT_THRESHOLD)); cur = cur.slice(SPLIT_THRESHOLD); }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ── 双端优先级：本机心跳门控（电脑活着=本机回，关机=云端接）──
const BEAT_URL = env('WXBOT_BEAT_URL', 'https://aale.pages.dev/wxbot-beat');
const LOCAL_PRIORITY = String(env('WXBOT_LOCAL_PRIORITY', 'false')) === 'true';
const BEAT_MAX_AGE_MS = Number(env('WXBOT_BEAT_MAX_AGE_MS', 15 * 60 * 1000));
let beatCache = { at: 0, localAlive: false };
async function localAlive() {
  if (Date.now() - beatCache.at < 30000) return beatCache.localAlive;
  let alive = beatCache.localAlive;
  try {
    const r = await fetch(BEAT_URL, { signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    const last = Number(j.lastBeatMs || 0);
    alive = last > 0 && Date.now() - last < BEAT_MAX_AGE_MS;
  } catch (e) { log('WARN', 'beat check fail ' + e.message); }
  beatCache = { at: Date.now(), localAlive: alive };
  return alive;
}

// ── 时间/文本工具（一律北京时间 UTC+8）──
const p2 = n => String(n).padStart(2, '0');
function nowCST() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}
function fmtCST(t) {
  if (!t) return '';
  const d = new Date(t); if (isNaN(d.getTime())) return '';
  const x = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${p2(x.getUTCMonth() + 1)}-${p2(x.getUTCDate())} ${p2(x.getUTCHours())}:${p2(x.getUTCMinutes())}`;
}
function deEnt(s) {
  return String(s).replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
function pickTag(block, tag) {
  const m = block.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>'));
  return m ? deEnt(m[1]) : '';
}

// ── 新闻抓取：GDELT（全球多语）+ Google News RSS（中文时效）——都是免费公开源、零 key ──
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
async function getText(url, timeoutMs) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(timeoutMs || 12000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}
async function fetchGdelt(query) {
  // GDELT 的 query 语法挑剔：裸中文串会被它拒（返回纯文本错误页）→ 用引号包成短语
  const q = '"' + String(query).replace(/"/g, '') + '"';
  const u = 'https://api.gdeltproject.org/api/v2/doc/doc?query=' + encodeURIComponent(q) +
    '&mode=artlist&format=json&maxrecords=' + MAX_ITEMS + '&sort=datedesc&timespan=2d';
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('GDELT HTTP ' + r.status);
  const d = await r.json();
  const art = (d.artifacts || d.data || []);
  return art.slice(0, MAX_ITEMS).map(a => ({
    title: deEnt(a.title || ''), url: a.url || '', source: 'GDELT',
    time: a.seendate ? new Date(a.seendate.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6Z')).toISOString() : '',
  }));
}
async function fetchGNews(q) {
  const u = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:3d') + '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans';
  const xml = await getText(u, 12000);
  const items = []; const re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) && items.length < MAX_ITEMS * 2) {
    const b = m[1];
    let title = pickTag(b, 'title'), url = pickTag(b, 'link');
    const src = pickTag(b, 'source'), pub = pickTag(b, 'pubDate');
    if (!title) continue;
    let source = src || '';
    // Google News 标题尾巴是 " - 来源"，来源已在 <source> 里 → 去掉重复尾巴
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
    items.push({ title, url, source: source || 'Google News', time: pub ? new Date(pub).toISOString() : '' });
  }
  return items;
}
function unwrapBing(u) {
  const m = String(u).match(/[?&]url=([^&]+)/);
  if (!m) return String(u);
  try { return decodeURIComponent(m[1]); } catch { return String(u); }
}
async function fetchBing(q) {
  // 注意：Bing 加 &mkt= 或换 cn.bing.com 会返回 HTML（不是 RSS），只能用它默认市场
  const u = 'https://www.bing.com/news/search?q=' + encodeURIComponent(q) + '&format=RSS&setlang=zh-CN';
  const xml = await getText(u, 12000);
  const items = []; const re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) && items.length < MAX_ITEMS * 2) {
    const b = m[1];
    let title = pickTag(b, 'title');
    const url = unwrapBing(pickTag(b, 'link'));
    if (!title) continue;
    let source = '';
    try { source = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    items.push({ title, url, source: source || 'Bing', time: pickTag(b, 'pubDate') ? new Date(pickTag(b, 'pubDate')).toISOString() : '' });
  }
  return items;
}
const normTitle = t => String(t).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
function dedupeSort(all, keepHours) {
  const seen = new Set(), seenT = new Set(); const out = [];
  for (const it of all) {
    if (!it.title && !it.url) continue;
    const h = crypto.createHash('sha1').update((it.url || it.title).toLowerCase() + '|' + String(it.title).replace(/\s+/g, ' ').slice(0, 80)).digest('hex').slice(0, 16);
    if (seen.has(h)) continue;
    const tk = normTitle(it.title).slice(0, 24);       // 同一条新闻在多源出现（标题几乎一致）→ 只留先到的
    if (tk.length >= 8 && seenT.has(tk)) continue;
    seen.add(h); if (tk.length >= 8) seenT.add(tk); it.hash = h; out.push(it);
  }
  out.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  if (keepHours) {
    const cut = Date.now() - keepHours * 3600 * 1000;
    const fresh = out.filter(x => !x.time || new Date(x.time).getTime() >= cut);
    if (fresh.length >= 3) return fresh;
  }
  return out;
}
async function searchNews(topic) {
  const q = String(topic || '').trim() || '最新 新闻';
  // Bing 放最前：它的 link 是原始站点直链（已拆掉 apiclick 包装），国内手机不翻墙也能打开；
  // Google News 覆盖更广但链接是 news.google.com 跳转页。GDELT 作补充（英文主题更有效）
  const [b, g, d] = await Promise.all([
    fetchBing(q).catch(e => { log('WARN', 'Bing fail=' + e.message); return []; }),
    fetchGNews(q).catch(e => { log('WARN', 'GNews fail=' + e.message); return []; }),
    fetchGdelt(q).catch(e => { log('WARN', 'GDELT fail=' + e.message); return []; }),
  ]);
  const direct = dedupeSort([...b, ...d], 72);          // 直链池（Bing/GDELT）
  const merged = dedupeSort([...b, ...d, ...g], 72);    // 全网池（直链优先占位）
  const out = []; const have = new Set();
  const add = it => { if (out.length < MAX_ITEMS && !have.has(it.hash)) { have.add(it.hash); out.push(it); } };
  for (const it of direct.slice(0, Math.min(direct.length, Math.max(3, Math.ceil(MAX_ITEMS / 2))))) add(it);
  for (const it of merged) add(it);
  out.sort((x, y) => (y.time || '').localeCompare(x.time || ''));
  log('INFO', `search q=${q} bing=${b.length} gnews=${g.length} gdelt=${d.length} out=${out.length}`);
  return out;
}

// ── AI（Agnes，OpenAI 兼容）：失败一律降级为纯列表，绝不让 AI 拖死回复 ──
async function agnes(messages, timeoutMs, maxTokens) {
  if (!AGNES_KEY) throw new Error('AGNES_API_KEY 未配置');
  const body = JSON.stringify({ model: AGNES_MODEL, messages, max_tokens: maxTokens || 1200 });
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(AGNES_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AGNES_KEY },
        body, signal: AbortSignal.timeout(timeoutMs || AI_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error('Agnes HTTP ' + r.status);
      const j = await r.json();
      const c = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      if (!c.trim()) throw new Error('Agnes 空回复');
      return c.trim();
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise(r2 => setTimeout(r2, 2000));
    }
  }
  throw lastErr;
}
const listOf = (items, withUrl) => items.map((it, i) =>
  `${i + 1}. ${it.title || '(无标题)'}${it.source ? '（' + it.source + '）' : ''}${it.time ? ' ' + fmtCST(it.time) : ''}${withUrl && it.url ? '\n   ' + it.url : ''}`
).join('\n');

async function answerNews(from, topic) {
  const items = await searchNews(topic);
  if (!items.length) {
    await sendText(from, `乐哥 没搜到「${topic}」的近期公开报道（GDELT+Google News 近 3 天）。不编旧闻，换个关键词再问，或试试「日报」。`, ctxTokens[from]);
    return;
  }
  let head = '';
  try {
    head = await agnes([
      { role: 'system', content: `你是新闻秘书。当前北京时间：${nowCST()}。${HONOR}只用我给的条目作答，禁用你记忆里的旧闻、不许编时间与数字。输出 3-5 条要点，每条一行、以"· "开头、不超过 40 字，点出最关键的信息与方向（涉黄金/白银/原油标注 利多/利空/中性）。不要写标题列表，不要写链接。` },
      { role: 'user', content: `主题「${topic}」，以下是刚抓到的 ${items.length} 条新闻（新→旧）：\n` + listOf(items.slice(0, AI_ITEM_CAP), false) },
    ], AI_TIMEOUT_MS, 700);
  } catch (e) { log('WARN', 'ai digest fail ' + e.message); }
  const body = `🔎 ${topic} · 近 3 天 · ${items.length} 条${head ? '\n\n' + head : ''}\n\n—— 原始条目 ——\n` + listOf(items, true);
  await sendChunks(from, body, ctxTokens[from]);
  log('INFO', `news reply sent topic=${topic} items=${items.length} ai=${head ? 'ok' : 'off'}`);
}

const DAILY_TOPICS = ['黄金', '白银', '原油', '美联储', 'A股', '苹果', '科技'];
let dailyRunning = false;
async function collectDaily() {
  const all = [];
  for (let i = 0; i < DAILY_TOPICS.length; i += 3) {          // 分批 3 个主题并发，400MB 容器也稳
    const batch = DAILY_TOPICS.slice(i, i + 3);
    const res = await Promise.all(batch.map(t => searchNews(t).catch(() => [])));
    batch.forEach((t, k) => { for (const it of res[k]) all.push({ ...it, topic: t }); });
  }
  return dedupeSort(selectBalanced(all), 72).slice(0, DAILY_MAX);
}
function selectBalanced(all) {
  // 平衡取样：每个主题最多 4 条，优先"标题含主题词"的条目（压掉股东户数这类噪声）
  const byTopic = new Map();
  for (const it of all) { const a = byTopic.get(it.topic) || []; a.push(it); byTopic.set(it.topic, a); }
  const pool = [];
  for (const [t, arr] of byTopic) {
    arr.sort((x, y) => (y.time || '').localeCompare(x.time || ''));
    const hit = arr.filter(it => String(it.title).includes(t));
    pool.push(...(hit.length >= 2 ? hit.slice(0, 4) : arr.slice(0, 4)));
  }
  return pool;
}
async function answerDaily(from) {
  if (dailyRunning) { await sendText(from, '乐哥 上一份还在生成，稍等 1 分钟。', ctxTokens[from]); return; }
  dailyRunning = true;
  try {
    await sendText(from, '乐哥 收到，正在搜今日要闻（7 个主题 × 3 个源），约 1 分钟。', ctxTokens[from]);
    const top = await collectDaily();
    if (!top.length) { await sendText(from, '乐哥 今天两个源都没返回内容（可能网络受限），稍后再试。', ctxTokens[from]); return; }
    let head = '';
    try {
      head = await agnes([
        { role: 'system', content: `你是新闻秘书。当前北京时间：${nowCST()}。${HONOR}只用我给的条目作答，禁用旧闻与编造。给一份极简早报导读：4-6 行，每行"· "开头、≤40 字，按 贵金属 / 能源 / 宏观 / 股市 / 科技 归类要点，涉黄金白银原油标 利多/利空/中性。不要链接、不要编号列表。` },
        { role: 'user', content: `今日候选要闻（新→旧，共 ${top.length} 条）：\n` + listOf(top, false) },
      ], AI_TIMEOUT_MS, 800);
    } catch (e) { log('WARN', 'daily ai fail ' + e.message); }
    const body = `📰 今日要闻 · ${nowCST().slice(0, 10)} · ${top.length} 条${head ? '\n\n' + head : ''}\n\n—— 原始条目 ——\n` + listOf(top, true);
    await sendChunks(from, body, ctxTokens[from]);
    log('INFO', `daily sent items=${top.length} ai=${head ? 'ok' : 'off'}`);
  } catch (e) {
    log('WARN', 'daily fail ' + e.message);
    await sendText(from, '乐哥 日报这次没生成成功（' + e.message + '），再发一次「日报」重试。', ctxTokens[from]);
  } finally { dailyRunning = false; }
}

// ── 意图识别：新闻词/时效词 → 搜索；指令 → 对应动作；其他 → 闲聊 ──
const NEWS_KW = ['新闻', '资讯', '金价', '银价', '油价', '行情', '走势', '头条', '局势', '地缘', '黄金', '白银', '美元', '原油', '美联储', '非农', 'CPI', 'A股', '人民币', '中东', '以色列', '伊朗', '俄罗斯', '乌克兰', '关税', '制裁', 'OPEC', '科技', '特斯拉', 'OpenAI', '美股', '日经', '财报', '经济', '楼市', '房价', '央行', '加息', '降息', '苹果', '华为', '小米', '三星', '手机', '芯片', '英伟达', '微软', '谷歌', '马斯克', '比亚迪', '茅台', '股价', 'gold', 'silver', 'oil', 'crude', 'fed', 'news', 'iran', 'israel', 'opec', 'tesla'];
const NEWS_INTENT = ['最新', '最近', '近期', '什么时候', '今天', '明天', '本周', '上周', '开售', '预售', '首发', '发布', '上市', '新机', '新款', '价格', '售价', '多少钱', '会涨', '会跌', '涨吗', '跌吗', '值得', '推荐', '评测', '对比', '怎么样', '如何', '动态', '消息', '进展', '形势', '爆火', '道歉', '罚款', '封禁', '起诉', '开庭', '判决', '获批', '召回', '跳票', '传闻', '爆料', '重磅', '突发', '独家', '早报', '晚报', '情况'];
const isNewsAsk = t => { const s = String(t); return NEWS_KW.some(k => s.includes(k)) || NEWS_INTENT.some(k => s.includes(k)); };
const TOPIC_WORDS = ['A股', 'CPI', 'PPI', 'PMI', 'OPEC', 'OpenAI', '特斯拉', '美联储', '非农', '俄罗斯', '乌克兰', '以色列', '伊朗', '黄金', '白银', '美元', '原油', '油价', '楼市', '房价', '美股', '日经', '关税', '人民币', '中东', '科技', '经济', '央行', '加息', '降息', '战争', '地缘', '制裁', 'gold', 'silver', 'oil', 'crude', 'fed', 'iran', 'israel', 'opec', 'tesla'];
const ASK_VERBS = ['最新消息', '最新', '最近', '近期', '什么时候', '几点', '几月', '今年', '明年', '今天', '明天', '本周', '上周', '今晚', '开售', '预售', '首发', '发布会', '发布', '上市', '新机', '新款', '价格', '售价', '多少钱', '会涨', '会跌', '涨吗', '跌吗', '值不值', '值得', '推荐', '评测', '测评', '对比', '怎么样', '如何', '表现', '动态', '消息', '资讯', '头条', '新闻', '行情', '走势', '局势', '形势', '情况', '进展', '传闻', '爆料', '重磅', '突发', '独家', '早报', '晚报', '有没有', '有吗', '查一下', '搜一下', '看看', '请问', '麻烦', '帮我', '一下', '的', '了', '吗', '呢', '吧', '啊', '？', '?', '！', '!', '。', '，'];
function extractTopic(t) {
  const s = String(t);
  for (const tp of TOPIC_WORDS) if (s.includes(tp)) return tp;
  let rest = s;
  for (const v of ASK_VERBS) rest = rest.split(v).join('');
  rest = rest.replace(/^(搜|查|问|找)\s*/, '').replace(/\s+/g, ' ').trim();
  if (!rest || ['有什么', '什么', '啥', '有吗'].includes(rest)) return '最新 新闻';
  return rest.slice(0, 30);
}
const HELP = `乐哥 我在这儿，用法就三条：

1. 直接问新闻 —— 例如「黄金」「苹果折叠屏最新消息」「伊朗局势」，我实时搜了整理给您。
2. 发「日报」—— 7 个主题（金/银/油/美联储/A股/苹果/科技）汇总一份要闻。
3. 随便聊 —— 问别的也行。

数据来自 GDELT + Google News（免费公开源），实时抓取，不用本机开机。`;

const chatHistFile = path.join(STATE_DIR, ACCOUNT_ID + '.chat.json');
let chatHist = loadJson(chatHistFile, {}) || {};
async function chatReply(userText, from) {
  const content = await agnes([
    { role: 'system', content: '你是乐哥的私人 AI 助手"小M"，通过微信对话。' + HONOR + '用中文，直接给答案不啰嗦，不确定的直说不确定，不编造。' },
    ...(chatHist[from] || []).slice(-6),
    { role: 'user', content: userText },
  ], AI_TIMEOUT_MS, 1200);
  if (content) {
    const h = chatHist[from] = (chatHist[from] || []);
    h.push({ role: 'user', content: userText }, { role: 'assistant', content });
    if (h.length > 12) chatHist[from] = h.slice(-12);
    saveJson(chatHistFile, chatHist);
  }
  return content;
}

async function handleInbound(m) {
  const from = String(m.from_user_id || '').trim();
  if (!from) return;
  if (ALLOWED.length && !ALLOWED.includes(from)) { log('INFO', 'ignored from non-allowed user'); return; }
  if (m.context_token) { ctxTokens[from] = m.context_token; saveJson(ctxFile, ctxTokens); }
  let text = '';
  for (const it of (m.item_list || [])) if (it.type === 1) text += (it.text_item || {}).text || '';
  text = text.trim(); if (!text) return;
  try {
    if (/^(帮助|命令|help|用法|怎么用|说明)$/i.test(text)) { await sendChunks(from, HELP, ctxTokens[from]); return; }
    if (text.includes('日报') || text.includes('每日报告') || text.includes('今日报') || text.includes('要闻')) { await answerDaily(from); return; }
    if (isNewsAsk(text)) { await answerNews(from, extractTopic(text)); return; }
    const reply = await chatReply(text, from);
    if (reply) await sendChunks(from, reply, ctxTokens[from]);
  } catch (e) { log('WARN', 'inbound pipeline fail ' + e.message); }
}

// ── 二维码登录（token 缺失/过期时自愈）──
async function qrLogin() {
  log('INFO', 'starting QR login');
  const qr = await apiGet('ilink/bot/get_bot_qrcode?bot_type=bot', '', 35000);
  const qv = String(qr.qrcode || ''), qurl = String(qr.qrcode_img_content || '');
  log('INFO', '请用微信扫一扫登录: ' + qurl);
  const deadline = Date.now() + 5 * 60000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    let st; try { st = await apiGet(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qv)}`, '', 35000); } catch (e) { continue; }
    const s = String(st.status || 'wait');
    if (s === 'confirmed') {
      TOKEN = String(st.bot_token || '');
      if (!TOKEN) throw new Error('QR confirmed but payload incomplete');
      fs.writeFileSync(SECRETS_FILE + '.newtoken', 'WEIXIN_TOKEN=' + TOKEN + '\n', { mode: 0o600 });
      log('INFO', 'QR confirmed, new token written to .secrets.newtoken (restart to activate)');
      return true;
    }
    if (s === 'expired') return false;
  }
  return false;
}

// ── 主轮询循环 ──
async function pollLoop() {
  let fails = 0, lastStoodBy = false;
  log('INFO', `poll loop started ${VERSION} account=${ACCOUNT_ID} allowed=${ALLOWED.length} client=${clientId} rss=${process.memoryUsage().rss / 1048576 | 0}MB`);
  while (true) {
    try {
      if (LOCAL_PRIORITY) {
        const alive = await localAlive();
        if (alive !== lastStoodBy) { log('INFO', alive ? 'LOCAL ALIVE → cloud stands by (no iLink calls)' : 'LOCAL HEARTBEAT EXPIRED → cloud takes over iLink'); lastStoodBy = alive; }
        if (alive) { await new Promise(r => setTimeout(r, 60000)); continue; }
      }
      const resp = await getUpdates(syncBuf, TOKEN, LONG_POLL_TIMEOUT_MS);
      const ret = resp.ret ?? 0, errcode = resp.errcode ?? 0;
      if (ret !== 0 || errcode !== 0) {
        if (errcode === SESSION_EXPIRED || ret === SESSION_EXPIRED) {
          log('WARN', 'session expired (-14): 需要重新扫码登录（node index.js qrlogin）');
          await new Promise(r => setTimeout(r, 600000)); fails = 0; continue;
        }
        fails++;
        log('WARN', `getUpdates ret=${ret} errcode=${errcode} errmsg=${resp.errmsg || ''} (${fails}/${MAX_FAILS})`);
        if (errcode === RATE_LIMIT) { await new Promise(r => setTimeout(r, BACKOFF_DELAY_MS)); continue; }
        await new Promise(r => setTimeout(r, fails >= MAX_FAILS ? BACKOFF_DELAY_MS : RETRY_DELAY_MS));
        if (fails >= MAX_FAILS) fails = 0;
        continue;
      }
      fails = 0;
      for (const m of (resp.msgs || [])) handleInbound(m).catch(e => log('ERROR', 'inbound error ' + e.message));
      const nb = String(resp.get_updates_buf || '');
      if (nb && nb !== syncBuf) { syncBuf = nb; saveJson(syncBufFile, { buf: syncBuf }); }
    } catch (e) {
      if (String(e.message || e).includes('timeout') || e.name === 'TimeoutError') continue;
      fails++;
      log('ERROR', `poll error (${fails}): ${e.message || e}`);
      await new Promise(r => setTimeout(r, fails >= MAX_FAILS ? BACKOFF_DELAY_MS : RETRY_DELAY_MS));
      if (fails >= MAX_FAILS) fails = 0;
    }
  }
}

process.on('unhandledRejection', e => log('ERROR', 'unhandledRejection ' + (e && e.message || e)));

(async () => {
  const mode = process.argv[2] || 'poll';
  if (mode === '--selftest') {   // 本机自检：不碰 iLink，只验证"搜索+AI"链路
    const topic = process.argv[3] || '黄金';
    const items = await searchNews(topic);
    console.log(`[selftest] topic=${topic} items=${items.length}`);
    console.log(items.map((it, i) => `${i + 1}. ${it.title}（${it.source}）${fmtCST(it.time)}\n   ${it.url}`).join('\n'));
    try {
      const head = await agnes([{ role: 'system', content: `你是新闻秘书。${HONOR}只用给定条目作答。输出 3 条要点，每条一行、以"· "开头。` },
        { role: 'user', content: `主题「${topic}」：\n` + listOf(items.slice(0, AI_ITEM_CAP), false) }], AI_TIMEOUT_MS, 400);
      console.log('[selftest] AI 导读:\n' + head);
    } catch (e) { console.log('[selftest] AI 失败(会降级纯列表)：' + e.message); }
    process.exit(items.length ? 0 : 1);
  }
  if (mode === '--selftest-daily') {   // 自检日报聚合（不碰 iLink）：node index.js --selftest-daily
    const t0 = Date.now();
    const top = await collectDaily();
    console.log(`[selftest] daily items=${top.length} 用时=${((Date.now() - t0) / 1000).toFixed(1)}s rss=${process.memoryUsage().rss / 1048576 | 0}MB`);
    console.log(top.map((it, i) => `${i + 1}. ${it.title}（${it.source}）${fmtCST(it.time)}\n   ${it.url}`).join('\n'));
    process.exit(top.length ? 0 : 1);
  }
  if (mode === 'qrlogin') { const ok = await qrLogin(); process.exit(ok ? 0 : 1); }
  if (!TOKEN) { log('ERROR', 'WEIXIN_TOKEN missing — run `node index.js qrlogin` first'); process.exit(1); }
  if (mode === 'ping') {
    const r = await getUpdates(syncBuf, TOKEN, 30000).then(j => ({ ok: !j.ret, ret: j.ret, errcode: j.errcode })).catch(e => ({ ok: false, err: e.message }));
    log('INFO', 'ping result ' + JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }
  pollLoop().catch(e => { log('ERROR', 'fatal ' + e.stack); process.exit(1); });
})();
