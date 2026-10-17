// iLink 微信云端问答机器人 — v5「内容版」（Pterodactyl 容器 / Node 22+ / 零依赖）
// 兼容标记（旧版 v4 的自更新会校验这个串，别删）: v4-simple
// 设计目标：400MB 内存里稳定跑。没有 Python、没有 uv、没有任何安装步骤，只有 Node + 网络。
//   ① 您问什么新闻 → Bing + Google News + GDELT 实时搜 → 抓正文 → AI 评分+摘要 → 按重要性排序回微信
//   ② 发「日报」 → 7 主题聚合 → 同样评分+摘要 → 15 条要闻
//   ③ 其他闲聊 → AI 直接回
// 内容资产移植自 ThysraelHorizon 的 finance-news profile（评分表 9-10 系统性 … 0-2 噪声；摘要规范）
// 部署：只传本文件到 /home/container/ → 面板 Restart。自检：node index.js --selftest-reply 黄金
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

const VERSION = 'v5-content';
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
const MAX_ITEMS = 8, AI_ITEM_CAP = 14, DAILY_MAX = 15;
// 正文抓取与评分（v5）：条数要克制，400MB 容器里 HTTP 并发 4 是安全线
const BODY_BUDGET_NEWS = 8, BODY_BUDGET_DAILY = 14, BODY_LIMIT_NEWS = 1500, BODY_LIMIT_DAILY = 1100;
const FETCH_CONCURRENCY = 4;
const SCORE_TIMEOUT_MS = Number(env('WXBOT_SCORE_TIMEOUT_MS', '90000'));
const MIN_SCORE = Number(env('WXBOT_MIN_SCORE', '3'));   // 评分低于此值且条数够 → 当噪声丢掉

// ── 全球免费源（全部零 key，实测可用 2026-10-17）──
// 金融/地缘/特朗普/美联储优先。每条带 RSS 里的正文摘要（免费内容，不用再抓网页）
const FEEDS = {
  trump:    { name: 'Truth Social', url: 'https://trumpstruth.org/feed', limit: 20 },
  wh:       { name: '白宫', url: 'https://www.whitehouse.gov/presidential-actions/feed/', limit: 6 },
  fed:      { name: '美联储', url: 'https://www.federalreserve.gov/feeds/press_all.xml', limit: 8 },
  fedSpeak: { name: '美联储讲话', url: 'https://www.federalreserve.gov/feeds/speeches.xml', limit: 8 },
  cnbc:     { name: 'CNBC', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', limit: 20 },
  wsj:      { name: 'WSJ', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', limit: 12 },
  bbcW:     { name: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', limit: 20 },
  bbcB:     { name: 'BBC财经', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', limit: 20 },
  aj:       { name: '半岛', url: 'https://www.aljazeera.com/xml/rss/all.xml', limit: 20 },
  toi:      { name: 'Times of Israel', url: 'https://www.timesofisrael.com/feed/', limit: 10 },
  tass:     { name: 'TASS', url: 'https://tass.com/rss/v2.xml', limit: 12 },
  scmp:     { name: 'SCMP', url: 'https://www.scmp.com/rss/91/feed', limit: 12 },
  eia:      { name: 'EIA', url: 'https://www.eia.gov/rss/todayinenergy.xml', limit: 8 },
  oil:      { name: 'OilPrice', url: 'https://oilprice.com/rss/main', limit: 12 },
  invest:   { name: 'Investing', url: 'https://www.investing.com/rss/news_1.rss', limit: 8 },
  zh:       { name: 'ZeroHedge', url: 'https://feeds.feedburner.com/zerohedge/feed', limit: 12 },
};
const TOPIC_FEEDS = [
  { re: /特朗普|川普|trump|关税|tariff|贸易战|白宫|制裁|sanction/i, ids: ['trump', 'wh', 'cnbc', 'bbcW'] },
  { re: /美联储|fed|鲍威尔|沃什|加息|降息|利率|CPI|非农|通胀|美债|美元/i, ids: ['fed', 'fedSpeak', 'cnbc', 'wsj'] },
  { re: /地缘|中东|伊朗|以色列|哈马斯|俄乌|俄罗斯|乌克兰|战争|停火|霍尔木兹|胡塞|台海/i, ids: ['aj', 'bbcW', 'toi', 'tass'] },
  { re: /原油|油价|OPEC|能源|天然气/i, ids: ['oil', 'eia', 'zh'] },
  { re: /黄金|白银|金价|银价|贵金属|金银/i, ids: ['oil', 'zh', 'invest', 'wsj'] },
  { re: /A股|沪指|沪深|股市|港股|人民币/i, ids: ['scmp', 'bbcB', 'cnbc'] },
  { re: /科技|芯片|AI|人工智能|苹果|英伟达|OpenAI|特斯拉|半导体/i, ids: ['cnbc', 'bbcB', 'zh'] },
];
const DEFAULT_FEEDS = ['cnbc', 'bbcW', 'zh'];
// X（推特）：Nitter 中转 twiiit.com，免费无 key；但实例不稳（会 403），失败就静默跳过
// 账号池：realDonaldTrump（特朗普）/ NickTimiraos（WSJ 美联储记者）/ DeItaone（快讯）/ FirstSquawk / zerohedge
const feedCache = new Map();   // 同一次日报里多个主题会撞同一个源，缓存 2 分钟省流量
// 乐哥要求：回复只给内容，不带网站链接（要链接就把 WXBOT_LINKS=true 写进 .secrets）
const WITH_LINKS = String(env('WXBOT_LINKS', 'false')).toLowerCase() === 'true';
// 自更新源：微信发「更新」→ 拉最新 index.js 覆盖自己 → 重启生效
// 主用 GitHub API 直读（不走 raw 的 5 分钟 CDN 缓存），raw 作兜底
const UPDATE_URL = env('WXBOT_UPDATE_URL', 'https://api.github.com/repos/wolaiguge00008-boop/horizon-wxbot/contents/vps/index.js');
const UPDATE_URL_FALLBACK = env('WXBOT_UPDATE_URL2', 'https://raw.githubusercontent.com/wolaiguge00008-boop/horizon-wxbot/main/vps/index.js');
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
    title: deEnt(a.title || ''), url: a.url || '', source: 'GDELT', direct: true,
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
    try { source = new URL(url).hostname.replace(/^www\./, ''); }
    catch { source = (String(url).match(/^https?:\/\/([^/]+)/) || [])[1] || ''; }
    if (/^https?:/i.test(source)) source = (source.match(/^https?:\/\/([^/]+)/) || [])[1] || source;
    items.push({ title, url, source: source || 'Bing', direct: true, time: pickTag(b, 'pubDate') ? new Date(pickTag(b, 'pubDate')).toISOString() : '' });
  }
  if (!items.length) log('WARN', `Bing 0 条（HTTP 200, ${xml.length}B，正文开头：${xml.replace(/\s+/g, ' ').slice(0, 160)}）`);
  return items;
}
// ── 通用 RSS/Atom 解析（全球源用；description/content 直接当正文，省一次网页抓取）──
function parseFeed(xml, srcName, limit, descLimit) {
  const items = []; const re = /<(item|entry)[\s>]([\s\S]*?)<\/\1>/g; let m;
  while ((m = re.exec(xml)) && items.length < (limit || 12)) {
    const b = m[2];
    let title = deEnt(pickTag(b, 'title')).replace(/\s+/g, ' ').trim();
    let link = pickTag(b, 'link') || (b.match(/<link[^>]+href=["']([^"']+)/i) || [])[1] || '';
    const date = pickTag(b, 'pubDate') || pickTag(b, 'published') || pickTag(b, 'updated') || pickTag(b, 'dc:date');
    const descRaw = pickTag(b, 'description') || pickTag(b, 'content:encoded') || pickTag(b, 'summary') || pickTag(b, 'content');
    if (!title || title.length < 6) continue;
    const body = stripTags(descRaw).replace(/\s+/g, ' ').slice(0, descLimit || 700);
    items.push({ title, url: link, source: srcName, direct: false, body: body.length >= 80 ? body : '', time: date ? new Date(date).toISOString() : '' });
  }
  return items;
}
async function fetchFeed(spec) {
  const hit = feedCache.get(spec.url);
  if (hit && Date.now() - hit.at < 120000) return hit.items.slice();
  const xml = await getText(spec.url, 14000);
  const items = parseFeed(xml, spec.name, spec.limit, 800);
  log('INFO', `feed ${spec.name} bytes=${xml.length} items=${items.length}`);
  if (feedCache.size > 40) feedCache.clear();
  feedCache.set(spec.url, { at: Date.now(), items });
  return items.slice();
}
async function fetchX(user, limit) {
  const xml = await getText('https://twiiit.com/' + encodeURIComponent(user) + '/rss', 15000);
  const items = parseFeed(xml, 'X@' + user, limit || 12, 600);
  if (!items.length) throw new Error('空（实例 403/限流）');
  return items;
}
function topicFeedsFor(q) {
  const ids = new Set();
  for (const t of TOPIC_FEEDS) if (t.re.test(q)) for (const id of t.ids) ids.add(id);
  if (!ids.size) for (const id of DEFAULT_FEEDS) ids.add(id);
  return [...ids];
}
function xAccountsFor(q) {
  const out = new Set();
  if (/特朗普|川普|trump|关税|tariff|白宫|制裁|sanction/i.test(q)) out.add('realDonaldTrump');
  if (/美联储|fed|鲍威尔|沃什|加息|降息|利率|CPI|非农|通胀|美债|美元/i.test(q)) out.add('NickTimiraos');
  if (/黄金|白银|金价|银价|原油|油价|股市|A股|美股|OPEC|能源/i.test(q)) { out.add('DeItaone'); out.add('zerohedge'); }
  if (/地缘|中东|伊朗|以色列|俄乌|俄罗斯|乌克兰|战争|停火|霍尔木兹/i.test(q)) out.add('zerohedge');
  if (!out.size) { out.add('DeItaone'); out.add('zerohedge'); }
  return [...out].slice(0, 2);      // 最多 2 个账号：twiiit 不稳且慢，够用就行
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
  // 源分三类并发：
  //   ① 中文直链（Bing 拆包 / GDELT）—— 能抓网页正文，国内也能直接打开
  //   ② 全球源（RSS：Truth Social / 白宫 / 美联储 / CNBC / BBC / 半岛 / TASS / OilPrice / EIA / ZeroHedge…）RSS 自带正文摘要
  //   ③ Google News —— 覆盖最广但链接是跳转页，只用来补广度
  const feedIds = topicFeedsFor(q), xs = xAccountsFor(q);
  const tasks = [
    ['bing', fetchBing(q)], ['gnews', fetchGNews(q)], ['gdelt', fetchGdelt(q)],
    ...feedIds.map(id => [id, fetchFeed(FEEDS[id])]),
    ...xs.map(u => ['x:' + u, fetchX(u)]),
  ];
  const settled = await Promise.allSettled(tasks.map(t => t[1]));
  const bing = [], gnews = [], gdelt = [], feeds = [], xits = [];
  tasks.forEach((t, i) => {
    const r = settled[i];
    if (r.status !== 'fulfilled') { log('WARN', `src ${t[0]} fail=${String((r.reason && r.reason.message) || r.reason).slice(0, 60)}`); return; }
    const arr = r.value || [];
    if (t[0] === 'bing') bing.push(...arr);
    else if (t[0] === 'gnews') gnews.push(...arr);
    else if (t[0] === 'gdelt') gdelt.push(...arr);
    else if (t[0].startsWith('x:')) xits.push(...arr);
    else feeds.push(...arr);
  });
  const zh = dedupeSort([...bing, ...gdelt], 72);
  const gl = dedupeSort([...feeds, ...xits], 72);
  const gn = dedupeSort(gnews, 72);
  const out = []; const have = new Set(); const srcCount = new Map();
  const add = it => {
    if (out.length >= AI_ITEM_CAP || have.has(it.hash)) return;
    const s = String(it.source || '');
    if ((srcCount.get(s) || 0) >= 3) return;      // 同一个源最多占 3 个候选位，别被一家刷屏
    have.add(it.hash); srcCount.set(s, (srcCount.get(s) || 0) + 1); out.push(it);
  };
  for (const it of zh.slice(0, 5)) add(it);      // 中文直链 5
  for (const it of gl.slice(0, 6)) add(it);      // 全球源 6（RSS 自带正文）
  for (const it of gn.slice(0, 4)) add(it);      // Google 补 3-4
  for (const it of dedupeSort([...zh, ...gl, ...gn], 72)) add(it);
  out.sort((x, y) => (y.time || '').localeCompare(x.time || ''));
  log('INFO', `search q=${q} bing=${bing.length} gnews=${gnews.length} gdelt=${gdelt.length} feeds=${feeds.length}[${feedIds.join(',')}] x=${xits.length} out=${out.length}`);
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
const fmtScore = n => (n == null || !isFinite(n)) ? '' : (Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(1));
// 有些源把整条 URL 塞进 <source> 标签（例如 ruibao.news）→ 显示前统一洗干净
const cleanSource = s => { let t = String(s || '').trim(); const m = t.match(/^https?:\/\/([^/\s]+)/i); if (m) t = m[1]; return t.replace(/^www\./, '').slice(0, 26); };

// ── ① 正文抓取（替代 trafilatura：去脚本样式 → 取正文段落，限 4 并发）──
function looksLikeCode(t) {
  if (!t) return true;
  const junk = (String(t).match(/[{}<>;=\\]|function\s|var\s|window\.|document\.|=>/g) || []).length;
  return junk > t.length / 40;      // 2.5% 以上是代码符号 → 判为脚本/CSS 残留
}
function stripTags(s) {
  return String(s).replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')   // 连内容一起删（旧版只删了标签，JS 全漏出来）
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*$/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
}
function decodeBody(buf) {
  const head = Buffer.from(buf.slice(0, 4096)).toString('latin1');
  const m = head.match(/charset\s*=\s*["']?([\w-]+)/i);
  let enc = 'utf8';
  if (m) {
    const e = m[1].toLowerCase();
    if (/gb2312|gbk|gb18030/.test(e)) enc = 'gbk'; else if (/big5/.test(e)) enc = 'big5';
  }
  try { return new TextDecoder(enc).decode(buf); } catch { return Buffer.from(buf).toString('utf8'); }
}
function extractArticle(html, limit) {
  const h = String(html);
  let meta = '';
  const md = h.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/i);
  if (md) { const c = md[0].match(/content=["']([^"']*)["']/i); if (c) meta = deEnt(c[1]); }
  let scope = h;
  const art = h.match(/<article[\s\S]{0,300000}?<\/article>/i) || h.match(/<main[\s\S]{0,300000}?<\/main>/i);
  if (art) scope = art[0];
  const ps = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(x => stripTags(x[1])).filter(t => t.length >= 24 && !looksLikeCode(t));
  let text = ps.join(' ');
  if (text.length < 200) { const alt = stripTags(scope); if (!looksLikeCode(alt)) text = (alt + ' ' + text).trim(); }
  if (text.length < 120 && meta) text = meta + ' ' + text;
  return text.replace(/\s+/g, ' ').slice(0, limit).trim();
}
async function fetchArticleText(url, limit) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(9000), redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const ct = String(r.headers.get('content-type') || '');
  if (!/text\/html|text\/plain|xhtml/i.test(ct)) throw new Error('非网页(' + ct.split(';')[0].slice(0, 24) + ')');
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 900 * 1024) throw new Error('页面过大');
  const t = extractArticle(decodeBody(buf), limit);
  if (t.length < 60) throw new Error('正文太短');
  return t;
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } }
  }));
  return out;
}
// 只抓"直链"条目（Bing 拆包后的原站、GDELT）；Google News 是跳转页，抓不到正文，跳过
async function enrichBodies(items, budget, perLimit) {
  const targets = items.filter(it => it.direct && /^https?:\/\//.test(String(it.url || ''))).slice(0, budget);
  log('INFO', `enrich pool n=${items.length} direct=${items.filter(x => x.direct).length} httpUrl=${items.filter(x => /^https?:\/\//.test(String(x.url || ''))).length} targets=${targets.length}`);
  let ok = 0;
  await mapLimit(targets, FETCH_CONCURRENCY, async it => {
    try { it.body = await fetchArticleText(it.url, perLimit); ok++; }
    catch (e) { log('WARN', `body fail ${it.source || ''} ${String(e.message).slice(0, 60)}`); }
  });
  log('INFO', `bodies ${ok}/${targets.length}`);
  return items;
}

// ── ② AI 评分 + 一句话摘要（资产移植：评分表 + 摘要规范）──
const SCORE_SYS = `你是财经新闻编辑。当前北京时间：${nowCST()}。${HONOR}
【任务】给每条新闻打分，并写一句内容摘要。
【评分标准 0-10】
- 9-10 系统性：重大货币或财政政策转向、严重市场动荡、标志性监管、影响面很广的公司事件
- 7-8 重要：重大财报意外、重大融资或并购、影响明确的经济数据或政策变化
- 5-6 有用：可信、具体的进展，能帮读者理解某公司、某个市场或趋势，但广度或紧迫性有限
- 3-4 低价值：常规价格波动、预期内的结果、小额交易、缺基线的预测
- 0-2 噪声：传闻、荐股或推广、没有解释的数字、耸动预测、没有可靠财经实质（例如把"黄金周旅游"当成金价新闻）
【评估要点】看事件规模与影响面、来源质量、时效性、是否给出带基线的具体数字；区分已报道事实与预测、观点；不因涨幅大就加分（必须看基数）；不把热度当重要性。
【摘要规范】每条一句话、最多 45 字：先说事件，再给最关键的数字或政策变化，保留货币、单位、时间区间与比较基准；公司说法、分析师预测、指控、提案都要标明来源；不确定的就别写，绝不编造；不要写"属重大事件""值得关注""影响深远"这类评价套话，直接给事实和数字。
【影响】只在有直接、实质影响时写一句（谁受影响、通过什么机制，<=30 字）；没有就留空字符串。不要重复摘要、不要泛泛而谈。
【去重】给每条一个 event：同一件事的短标识（4-10 字，例如"对俄关税豁免""美联储议息""iPhone发布""A股回购"）。多家媒体报同一件事必须用完全相同的 event 字符串。
【输出格式】只输出一个 JSON 数组，不要解释、不要代码块、不要多余文字：
[{"i":1,"score":8.5,"event":"事件短标识","tags":["黄金","央行购金"],"summary":"一句话摘要","impact":"影响（没有就空字符串）"}]`;
function parseJsonArray(s) {
  let t = String(s).replace(/```[a-z]*/gi, '').trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { const j = JSON.parse(t); if (Array.isArray(j)) return j; } catch {}
  const out = []; const re = /\{[^{}]*\}/g; let m;      // 容错：逐个对象抠
  while ((m = re.exec(t))) { try { const o = JSON.parse(m[0]); if (o && typeof o === 'object') out.push(o); } catch {} }
  return out;
}
async function scoreItems(topic, items) {
  const user = `主题「${topic}」，共 ${items.length} 条（新→旧）：\n\n` + items.map((it, i) =>
    `【${i + 1}】${it.title || ''}（${it.source || ''} ${fmtCST(it.time)}）${it.body ? '\n正文节选：' + it.body : ''}`).join('\n\n');
  const raw = await agnes([{ role: 'system', content: SCORE_SYS }, { role: 'user', content: user }], SCORE_TIMEOUT_MS, 2800);
  const arr = parseJsonArray(raw);
  const byIdx = new Map();
  for (const o of arr) { const i = Number(o && o.i); if (i >= 1 && i <= items.length && !byIdx.has(i)) byIdx.set(i, o); }
  let hit = 0;
  const scored = items.map((it, k) => {
    const o = byIdx.get(k + 1);
    const sc = o && isFinite(Number(o.score)) ? Number(o.score) : null;
    if (sc != null) hit++;
    return { ...it, score: sc, event: (o && o.event) ? String(o.event).replace(/\s+/g, '').slice(0, 14) : '',
      tags: (o && Array.isArray(o.tags)) ? o.tags.slice(0, 5).map(String) : [],
      summary: (o && o.summary) ? String(o.summary).replace(/\s+/g, ' ').slice(0, 90) : '',
      impact: (o && o.impact) ? String(o.impact).replace(/\s+/g, ' ').slice(0, 70) : '' };
  });
  log('INFO', `scored ${hit}/${items.length}（原始输出 ${raw.length} 字）`);
  return scored;
}
function rankItems(items, keep) {
  if (!items.some(x => typeof x.score === 'number' && isFinite(x.score))) return items.slice(0, keep);   // AI 没给分 → 保持时间序
  const sorted = items.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  const good = sorted.filter(x => !(typeof x.score === 'number' && x.score < MIN_SCORE));
  const floor = Math.min(6, keep);                                            // 至少保 6 条，别筛太狠；分数[1][2]那种就是给您看的"这条不用看"
  return (good.length >= floor ? good : sorted.slice(0, floor)).slice(0, keep);
}

// 同一件事多家媒体报 → 每件事最多留 2 条（留不同视角），其余位置让给别的事
function dedupeByEvent(items, keep) {
  const cnt = new Map(); const out = [];
  for (const it of items) {
    const k = String(it.event || '');
    if (k) { const c = cnt.get(k) || 0; if (c >= 2) continue; cnt.set(k, c + 1); }
    out.push(it);
    if (out.length >= keep) break;
  }
  if (out.length < Math.min(3, keep)) return items.slice(0, keep);   // 合并过头（全场就一件事）→ 回退按分数给
  return out;
}
// 先按分数排（多给 4 条余量给"同事件合并"腾位置），再合并同事件、截到 keep
function pickTop(items, keep) { return dedupeByEvent(rankItems(items, keep + 4), keep); }

// 回复排版（乐哥要求：只给内容，不带网址；★ 后面是重要性评分，越高越重要）
function renderItems(items) {
  return items.map((it, i) => {
    const sc = fmtScore(it.score);
    const head = `${i + 1}. ${sc ? '★' + sc + ' ' : ''}${it.title || '(无标题)'}${it.source ? '（' + cleanSource(it.source) + '）' : ''}${it.time ? ' ' + fmtCST(it.time) : ''}`;
    const sum = it.summary ? '\n   ' + it.summary : (WITH_LINKS && it.url ? '\n   ' + it.url : '');
    const imp = it.impact ? '\n   → 影响：' + it.impact : '';
    return head + sum + imp + (WITH_LINKS && it.summary && it.url ? '\n   ' + it.url : '');
  }).join('\n');
}
function buildReply(titleLine, aiHead, items) {
  const lines = [titleLine];
  if (aiHead) lines.push('', aiHead);
  lines.push('', WITH_LINKS ? '—— 原始条目 ——' : (items.some(x => x.summary) ? '—— 精选（★ 越高越重要）——' : '—— 标题 ——'), renderItems(items));
  return lines.join('\n');
}

async function answerNews(from, topic) {
  const items = await searchNews(topic);
  if (!items.length) {
    await sendText(from, `乐哥 没搜到「${topic}」的近期公开报道（Bing+Google News+GDELT 近 3 天）。不编旧闻，换个关键词再问，或试试「日报」。`, ctxTokens[from]);
    return;
  }
  const cands = items.slice(0, AI_ITEM_CAP);
  await enrichBodies(cands, BODY_BUDGET_NEWS, BODY_LIMIT_NEWS);      // 抓正文 → 摘要基于内容而不是标题
  let scored = [];
  try { scored = await scoreItems(topic, cands); } catch (e) { log('WARN', 'ai score fail ' + e.message); }
  const picked = pickTop(scored.length ? scored : cands, MAX_ITEMS);   // 按重要性排序 + 同事件合并 + 低分当噪声丢
  const gotBody = cands.filter(x => x.body).length;
  const body = buildReply(`🔎 ${topic} · 近 3 天 · 抓到 ${items.length} 条 → 精选 ${picked.length} 条`, '', picked);
  await sendChunks(from, body, ctxTokens[from]);
  log('INFO', `news reply sent topic=${topic} picked=${picked.length} scored=${scored.some(x => x.score != null) ? 'ok' : 'off'} bodies=${gotBody}`);
}

// 日报主题：按乐哥的重点排 —— 特朗普/关税、美联储、地缘 优先，再贵金属/能源/股市/科技
// kw 用于"标题是否沾主题"的排序加权（中英双语都要匹配）
const DAILY_TOPICS = [
  { q: '特朗普 关税', kw: ['特朗普', '川普', 'Trump', 'tariff', '关税'] },
  { q: '美联储 利率', kw: ['美联储', '沃什', '鲍威尔', 'Fed', 'Warsh', 'Powell', 'CPI'] },
  { q: '中东 局势', kw: ['伊朗', '以色列', '中东', 'Iran', 'Israel', 'Gaza', '霍尔木兹'] },
  { q: '黄金', kw: ['黄金', '金价', 'gold'] },
  { q: '白银', kw: ['白银', '银价', 'silver'] },
  { q: '原油', kw: ['原油', '油价', 'OPEC', 'oil', 'crude'] },
  { q: 'A股', kw: ['A股', '沪指', '沪深', '股市'] },
  { q: 'AI 芯片', kw: ['AI', '芯片', '英伟达', 'OpenAI', 'Nvidia', '半导体'] },
];
const JUNK_TITLE = /(调研|座谈|股东户数|户均持|读懂了|讨论区|招聘|免责声明|活动预告)/;
let dailyRunning = false;
async function collectDaily() {
  const all = [];
  for (let i = 0; i < DAILY_TOPICS.length; i += 3) {          // 分批 3 个主题并发，400MB 容器也稳
    const batch = DAILY_TOPICS.slice(i, i + 3);
    const res = await Promise.all(batch.map(t => searchNews(t.q).catch(() => [])));
    batch.forEach((t, k) => { for (const it of res[k]) all.push({ ...it, topic: t.kw }); });
  }
  return (() => {
    const pool = dedupeSort(selectBalanced(all), 72);
    // 直链占七成（能抓正文 → 摘要有内容），其余留给 Google News 补广度；先按配额取，再按时间排
    const direct = pool.filter(x => x.direct), rest = pool.filter(x => !x.direct);
    const chosen = [...direct.slice(0, Math.ceil(DAILY_MAX * 0.7)), ...rest].slice(0, DAILY_MAX);
    chosen.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
    return chosen;
  })();
}
function selectBalanced(all) {
  // 平衡取样：每主题最多 4 条、优先标题含主题词；先滤掉高校/公告/导流类噪声
  const clean = all.filter(it => !JUNK_TITLE.test(String(it.title) + ' ' + String(it.source)));
  const src = clean.length >= 12 ? clean : all;     // 滤太狠就放宽，保证 15 条
  const byTopic = new Map();
  for (const it of src) { const a = byTopic.get(it.topic) || []; a.push(it); byTopic.set(it.topic, a); }
  const pool = [];
  for (const [kw, arr] of byTopic) {
    const kws = Array.isArray(kw) ? kw : [kw];
    // 直链优先（能抓正文 → 摘要基于内容），同级再按时间新→旧；Google 跳转页补位
    arr.sort((x, y) => ((y.direct ? 1 : 0) - (x.direct ? 1 : 0)) || (y.time || '').localeCompare(x.time || ''));
    const hit = arr.filter(it => {
      const s = (String(it.title) + ' ' + String(it.source)).toLowerCase();
      return kws.some(k => s.includes(String(k).toLowerCase()));
    });
    pool.push(...(hit.length >= 2 ? hit.slice(0, 4) : arr.slice(0, 4)));
  }
  return pool;
}
async function answerDaily(from) {
  if (dailyRunning) { await sendText(from, '乐哥 上一份还在生成，稍等 1 分钟。', ctxTokens[from]); return; }
  dailyRunning = true;
  try {
    await sendText(from, '乐哥 收到，正在搜今日要闻（7 主题 × 3 源，抓正文 + 评分排序），约 1-2 分钟。', ctxTokens[from]);
    const top = await collectDaily();
    if (!top.length) { await sendText(from, '乐哥 今天几个源都没返回内容（可能网络受限），稍后再试。', ctxTokens[from]); return; }
    await enrichBodies(top, BODY_BUDGET_DAILY, BODY_LIMIT_DAILY);
    let ranked = top;
    try { ranked = pickTop(await scoreItems('今日要闻', top), DAILY_MAX); } catch (e) { log('WARN', 'daily score fail ' + e.message); }
    let head = '';
    try {
      head = await agnes([
        { role: 'system', content: `你是新闻秘书。当前北京时间：${nowCST()}。${HONOR}只用我给的条目作答，禁用旧闻与编造。给一份极简早报导读：4-6 行，每行"· "开头、≤40 字，按 贵金属 / 能源 / 宏观 / 股市 / 科技 归类要点，涉黄金白银原油标 利多/利空/中性。不要链接、不要编号列表。` },
        { role: 'user', content: `今日候选要闻（已按重要性排序，共 ${ranked.length} 条）：\n` + ranked.map((it, i) => `${i + 1}. ${it.title}${it.summary ? ' —— ' + it.summary : ''}`).join('\n') },
      ], AI_TIMEOUT_MS, 800);
    } catch (e) { log('WARN', 'daily ai fail ' + e.message); }
    const body = buildReply(`📰 今日要闻 · ${nowCST().slice(0, 10)} · 精选 ${ranked.length} 条`, head, ranked);
    await sendChunks(from, body, ctxTokens[from]);
    log('INFO', `daily sent items=${ranked.length} bodies=${top.filter(x => x.body).length} ai=${head ? 'ok' : 'off'}`);
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

1. 直接问新闻 —— 「黄金」「特朗普关税」「美联储」「伊朗局势」「英伟达」，我并发搜三类源（中文直链 + 全球一手源 + Google），抓正文，按重要性打分（★，10 分满分），每条给您一句摘要 + 影响。
2. 发「日报」—— 8 个重点：特朗普关税 / 美联储 / 中东局势 / 黄金 / 白银 / 原油 / A股 / AI芯片，约 1-2 分钟。
3. 随便聊 —— 问别的也行。

发「更新」= 升级到最新版（不用您再传文件）。
全球一手源：Truth Social（特朗普原帖）、白宫行政令、美联储（新闻+讲话）、CNBC、WSJ、BBC、半岛电视台、Times of Israel、TASS、SCMP、OilPrice、EIA、Investing、ZeroHedge、X/Twitter。
评分标准来自您本机 ThysraelHorizon 技能的 finance-news 档案（9-10 系统性 … 0-2 噪声）。`;

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

// ── 自更新：微信发「更新」→ 从 GitHub 拉最新 index.js 覆盖自己 → 退出让面板拉起新版 ──
let updating = false;
async function selfUpdate(from) {
  if (updating) { await sendText(from, '乐哥 正在更新中，稍等十几秒。', ctxTokens[from]); return; }
  updating = true;
  try {
    let src = '', lastErr = null;
    for (const u of [UPDATE_URL, UPDATE_URL_FALLBACK]) {
      try {
        const r = await fetch(u + (u.includes('raw.githubusercontent') ? '?t=' + Date.now() : ''), {
          headers: { 'User-Agent': UA, Accept: 'application/vnd.github.raw, text/plain, */*' },
          signal: AbortSignal.timeout(25000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        src = await r.text();
        if (src.length >= 10000) break;
        lastErr = new Error('文件太小 ' + src.length + 'B');
      } catch (e) { lastErr = e; log('WARN', 'update fetch fail ' + e.message); }
    }
    if (!src || src.length < 10000) throw new Error('下载失败：' + (lastErr ? lastErr.message : '空内容'));
    if (!/v[45]-(simple|content)/.test(src)) throw new Error('不是 wxbot 代码（缺版本标记）');
    try { new Function(src); } catch (e) { throw new Error('语法校验不过：' + e.message); }   // 只编译不执行
    let cur = ''; try { cur = fs.readFileSync(__filename, 'utf8'); } catch {}
    if (cur.trim() === src.trim()) { updating = false; await sendText(from, '乐哥 已经是最新版，不用更新。', ctxTokens[from]); return; }
    const tmp = __filename + '.new' + process.pid;
    fs.writeFileSync(tmp, src);
    fs.renameSync(tmp, __filename);            // 原子替换（目录可写即可，不依赖旧文件属主）
    try { fs.chmodSync(__filename, 0o755); } catch {}
    await sendText(from, `乐哥 新版已写入（${Buffer.byteLength(src)} 字节），正在重启进程，约 15 秒后生效。若没动静，面板点一次 Restart。`, ctxTokens[from]);
    log('INFO', `self-update applied ${Buffer.byteLength(src)}B → exiting for restart`);
    setTimeout(() => process.exit(0), 1500);
  } catch (e) {
    updating = false;
    log('WARN', 'self-update fail ' + e.message);
    await sendText(from, '乐哥 更新失败：' + e.message + '。原文件没动，服务照常。', ctxTokens[from]);
  }
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
    if (/^(更新|升级|更新版本|升级版本|update)$/i.test(text)) { await selfUpdate(from); return; }
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
  if (mode === '--selftest-reply') {   // 自检：跑完整 v5 链路（搜 → 正文 → 评分 → 排序），打印"微信里会收到的原文"，不发消息
    const topic = process.argv[3] || '黄金';
    const t0 = Date.now();
    const items = await searchNews(topic);
    const cands = items.slice(0, AI_ITEM_CAP);
    await enrichBodies(cands, BODY_BUDGET_NEWS, BODY_LIMIT_NEWS);
    let scored = [];
    try { scored = await scoreItems(topic, cands); } catch (e) { log('WARN', 'ai fail ' + e.message); }
    const ranked = pickTop(scored.length ? scored : cands, MAX_ITEMS);
    const body = buildReply(`🔎 ${topic} · 近 3 天 · 抓到 ${items.length} 条 → 精选 ${ranked.length} 条`, '', ranked);
    console.log(`----- 微信原文（${body.length} 字 / 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s / rss ${process.memoryUsage().rss / 1048576 | 0}MB / 抓到正文 ${cands.filter(x => x.body).length} 条 / 会分成 ${Math.ceil(body.length / SPLIT_THRESHOLD)} 条）-----`);
    console.log(body);
    process.exit(0);
  }
  if (mode === '--selftest-daily') {   // 自检日报完整链路（不碰 iLink）：node index.js --selftest-daily
    const t0 = Date.now();
    const top = await collectDaily();
    await enrichBodies(top, BODY_BUDGET_DAILY, BODY_LIMIT_DAILY);
    let ranked = top;
    try { ranked = pickTop(await scoreItems('今日要闻', top), DAILY_MAX); } catch (e) { log('WARN', 'daily score fail ' + e.message); }
    const body = buildReply(`📰 今日要闻 · ${nowCST().slice(0, 10)} · 精选 ${ranked.length} 条`, '', ranked);
    console.log(`[selftest] daily items=${ranked.length} 用时=${((Date.now() - t0) / 1000).toFixed(1)}s rss=${process.memoryUsage().rss / 1048576 | 0}MB 正文=${top.filter(x => x.body).length} 条`);
    console.log(`----- 日报微信原文（${body.length} 字 / 会分成 ${Math.ceil(body.length / SPLIT_THRESHOLD)} 条）-----`);
    console.log(body);
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
