#!/usr/bin/env node
/* TaqOptionKe — single-file binary trading platform
   Zero dependencies. Node 18+.
   Digit trading on Volatility Indices (matches Deriv mechanics) */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');

/* ===================== CONFIG ===================== */
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'taqoptionke-secret-2026-change-in-prod';
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';
const USD_KES = Number(process.env.USD_KES_RATE || 130);
const DEMO_MODE = process.env.DEMO_MODE !== 'false';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const USDT_ADDRESS = 'TScp5kZKdMTUyEF8JgwzS7x1Ets9xiUPxi';
const ZETUPAY_SECRET_KEY = process.env.ZETUPAY_SECRET_KEY || '';
const ZETUPAY_BASE = 'https://pay.zetupay.co.ke/api/v1';

/* ===================== INDICES (Deriv-style) ===================== */
const INDICES = {
  vol10:  { id:'vol10',  name:'Vol 10 (1s)',  base:9534.43, vol:2.5, decimals:2 },
  vol25:  { id:'vol25',  name:'Vol 25 (1s)',  base:6355.20, vol:5,   decimals:2 },
  vol50:  { id:'vol50',  name:'Vol 50 (1s)',  base:3428.90, vol:10,  decimals:2 },
  vol75:  { id:'vol75',  name:'Vol 75 (1s)',  base:1854.30, vol:15,  decimals:2 },
  vol100: { id:'vol100', name:'Vol 100 (1s)', base:970.50,  vol:20,  decimals:2 }
};

/* ===================== DB ===================== */
let db = { users:[], trades:[], txs:[], ticks:{} };
for (const id in INDICES) db.ticks[id] = [];
try {
  fs.mkdirSync(DATA_DIR, { recursive:true });
  if (fs.existsSync(DB_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(DB_FILE,'utf8'));
    Object.assign(db, loaded);
    for (const id in INDICES) if (!db.ticks[id]) db.ticks[id] = [];
  }
} catch(e){ console.warn('DB load:', e.message); }
function save(){ try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch(e){ console.warn('DB save:',e.message); } }

const findUser = e => db.users.find(u => u.email === e);
const findUserById = id => db.users.find(u => u.id === id);

/* ===================== PASSWORD ===================== */
function hashPw(pw){
  const s = crypto.randomBytes(16).toString('hex');
  return s + ':' + crypto.scryptSync(pw, s, 64).toString('hex');
}
function checkPw(pw, stored){
  if (!stored || !stored.includes(':')) return false;
  const [s,h] = stored.split(':');
  try {
    const t = crypto.scryptSync(pw, s, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h,'hex'), Buffer.from(t,'hex'));
  } catch { return false; }
}

/* ===================== TOKENS ===================== */
function sign(p){
  const d = Buffer.from(JSON.stringify({...p, exp: Date.now()+2592000000})).toString('base64url');
  return d + '.' + crypto.createHmac('sha256',JWT_SECRET).update(d).digest('base64url');
}
function verify(t){
  if (!t || typeof t !== 'string') return null;
  const [d,s] = t.split('.');
  if (!d || !s) return null;
  const exp = crypto.createHmac('sha256',JWT_SECRET).update(d).digest('base64url');
  if (s !== exp) return null;
  try { const p = JSON.parse(Buffer.from(d,'base64url').toString()); return p.exp < Date.now() ? null : p; }
  catch { return null; }
}

/* ===================== TICK ENGINE ===================== */
function lastDigit(p, dec){ return Math.floor(Math.abs(p) * Math.pow(10, dec)) % 10; }

const state = {};
for (const id in INDICES) {
  const cfg = INDICES[id];
  state[id] = { price: cfg.base };
  if (db.ticks[id].length < 50) {
    db.ticks[id] = [];
    let p = cfg.base;
    const now = Date.now();
    for (let i=0; i<150; i++) {
      p = Math.max(1, p + (Math.random()-0.5)*cfg.vol);
      db.ticks[id].push({ price: +p.toFixed(cfg.decimals), digit: lastDigit(p, cfg.decimals), time: now-(150-i)*1000 });
    }
    state[id].price = p;
    save();
  } else {
    state[id].price = db.ticks[id][db.ticks[id].length-1].price;
  }
}

const sseClients = new Set();
function broadcast(event, data){
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of sseClients) { try { res.write(payload); } catch { sseClients.delete(res); } }
}

setInterval(() => {
  const now = Date.now();
  for (const id in INDICES) {
    const cfg = INDICES[id];
    const s = state[id];
    s.price = Math.max(1, s.price + (Math.random()-0.5) * cfg.vol);
    const tick = { price: +s.price.toFixed(cfg.decimals), digit: lastDigit(s.price, cfg.decimals), time: now };
    db.ticks[id].push(tick);
    if (db.ticks[id].length > 400) db.ticks[id].shift();
    broadcast('tick', { index: id, tick });
  }
}, 1000);

/* ===================== SETTLEMENT ===================== */
const ODDS = {
  matches: () => 9.0,
  differs: () => 1.05,
  even:    () => 1.952,
  odd:     () => 1.952,
  over:    (b) => 1 + (9 - b) / 10 + 0.08,
  under:   (b) => 1 + b / 10 + 0.08
};

function settleTrade(t, tick){
  const d = tick.digit;
  let won = false, odds = 1.95;
  switch (t.kind) {
    case 'matches': won = d === t.prediction; odds = 9.0; break;
    case 'differs': won = d !== t.prediction; odds = 1.05; break;
    case 'even':    won = d % 2 === 0; odds = 1.952; break;
    case 'odd':     won = d % 2 === 1; odds = 1.952; break;
    case 'over':    won = d > t.prediction; odds = 1 + (9 - t.prediction)/10 + 0.08; break;
    case 'under':   won = d < t.prediction; odds = 1 + t.prediction/10 + 0.08; break;
  }
  t.exitDigit = d;
  t.exitPrice = tick.price;
  t.status = won ? 'won' : 'lost';
  t.odds = odds;
  t.profit = won ? +(t.stake * odds - t.stake).toFixed(2) : -t.stake;
  t.payout = won ? +(t.stake * odds).toFixed(2) : 0;
  t.settledAt = Date.now();
  if (won) {
    const u = findUserById(t.userId);
    if (u) {
      if (t.account === 'demo') u.demoBalance = +((u.demoBalance||10000) + t.stake * odds).toFixed(2);
      else u.balance = +((u.balance||0) + t.stake * odds).toFixed(2);
    }
  }
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  db.trades.forEach(t => {
    if (t.status !== 'open' || t.expiresAt > now) return;
    const tick = db.ticks[t.index][db.ticks[t.index].length-1];
    if (!tick) return;
    settleTrade(t, tick);
    db.txs.push({
      id: crypto.randomUUID(), userId: t.userId, account: t.account,
      type: t.status === 'won' ? 'trade_win' : 'trade_loss',
      amount: t.status === 'won' ? t.stake * t.odds : 0,
      ref: t.id, status: 'completed', createdAt: now
    });
    changed = true;
  });
  if (changed) save();
}, 1000);

/* ===================== ZETUPAY ===================== */
async function zetupayInitiate({ phone, amountKes, reference, redirectUrl }){
  if (!ZETUPAY_SECRET_KEY) return { demo: true, paymentKey: 'DEMO-' + crypto.randomUUID().slice(0,8), checkoutUrl: null };
  const res = await fetch(ZETUPAY_BASE + '/payment/initiate', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + ZETUPAY_SECRET_KEY },
    body: JSON.stringify({
      amount: amountKes,
      phoneNumber: phone,
      reference: reference,
      redirectUrl: redirectUrl,
      currency: 'KES',
      real: true
    })
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error((data && data.message) || ('ZetuPay HTTP ' + res.status));
  return data.data;
}

async function zetupayStatus(paymentKey){
  try {
    const res = await fetch(ZETUPAY_BASE + '/payment/' + encodeURIComponent(paymentKey));
    const data = await res.json();
    return data && data.success ? data.data : null;
  } catch { return null; }
}

/* ===================== HELPERS ===================== */
function pub(u){
  return {
    id: u.id, name: u.name, email: u.email,
    balance: u.balance || 0,
    demoBalance: u.demoBalance != null ? u.demoBalance : 10000,
    createdAt: u.createdAt
  };
}
function sendJSON(res, code, obj){
  res.writeHead(code, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*', 'Cache-Control':'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6){ reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { if (!b) return resolve({}); try { resolve(JSON.parse(b)); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
function authUser(req){
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return null;
  const p = verify(t);
  return p ? findUserById(p.id) : null;
}

/* ===================== HTTP SERVER ===================== */
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const method = req.method;
  const p = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Admin-Key');

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    const u = authUser(req);

    if (p === '/healthz') return sendJSON(res, 200, { ok: true, uptime: process.uptime(), demo: DEMO_MODE, zetupay: ZETUPAY_SECRET_KEY ? 'yes' : 'no' });

    /* SSE stream for live ticks */
    if (p === '/api/stream' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type':'text/event-stream',
        'Cache-Control':'no-cache, no-transform',
        'Connection':'keep-alive',
        'X-Accel-Buffering':'no'
      });
      res.write('event: init\ndata: ' + JSON.stringify({ indices: Object.keys(INDICES), ticks: Object.fromEntries(Object.keys(INDICES).map(id => [id, db.ticks[id].slice(-120)])) }) + '\n\n');
      sseClients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); sseClients.delete(res); } }, 25000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    /* Payment return page */
    if (p === '/payment/return' && method === 'GET') {
      res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
      return res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment received</title><style>body{background:#0a0e17;color:#e5e7eb;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}.box{max-width:380px}.t{font-size:22px;font-weight:800;color:#22c55e;margin-bottom:10px}.s{color:#9ca3af;font-size:14px;line-height:1.6}.btn{display:inline-block;margin-top:22px;padding:13px 28px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;border-radius:11px;font-weight:800;text-decoration:none}</style></head><body><div class="box"><div class="t">✓ Payment received</div><div class="s">Your deposit is being confirmed. Return to the app and your balance will update.</div><a class="btn" href="/">Return to TaqOptionKe</a></div></body></html>');
    }

    /* Serve frontend */
    if (!p.startsWith('/api/')) {
      if (method === 'GET') {
        res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' });
        return res.end(HTML);
      }
      return sendJSON(res, 404, { error:'not found' });
    }

    /* ---- AUTH ---- */
    if (p === '/api/auth/register' && method === 'POST') {
      const b = await readBody(req);
      if (!b.name || !b.email || !b.password) return sendJSON(res, 400, { error:'Missing fields' });
      if (b.password.length < 6) return sendJSON(res, 400, { error:'Password 6+ chars' });
      if (findUser(b.email.toLowerCase())) return sendJSON(res, 409, { error:'Email already registered' });
      const nu = {
        id: crypto.randomUUID(), name: b.name, email: b.email.toLowerCase(),
        password: hashPw(b.password), balance: 0, demoBalance: 10000,
        createdAt: Date.now()
      };
      db.users.push(nu); save();
      return sendJSON(res, 200, { token: sign({ id: nu.id, email: nu.email }), user: pub(nu) });
    }

    if (p === '/api/auth/login' && method === 'POST') {
      const b = await readBody(req);
      const user = findUser((b.email || '').toLowerCase());
      if (!user || !checkPw(b.password, user.password)) return sendJSON(res, 401, { error:'Invalid credentials' });
      if (user.demoBalance == null) { user.demoBalance = 10000; save(); }
      return sendJSON(res, 200, { token: sign({ id:user.id, email:user.email }), user: pub(user) });
    }

    if (p === '/api/me' && method === 'GET') {
      if (!u) return sendJSON(res, 401, { error:'Unauthorized' });
      return sendJSON(res, 200, pub(u));
    }

    /* ---- TICKS ---- */
    if (p === '/api/ticks' && method === 'GET') {
      const id = parsed.query.index || 'vol10';
      if (!db.ticks[id]) return sendJSON(res, 404, { error:'Unknown index' });
      return sendJSON(res, 200, db.ticks[id].slice(-120));
    }

    /* ---- INDICES ---- */
    if (p === '/api/indices' && method === 'GET') {
      return sendJSON(res, 200, Object.values(INDICES).map(i => ({
        id: i.id, name: i.name,
        price: db.ticks[i.id].length ? db.ticks[i.id][db.ticks[i.id].length-1].price : i.base,
        digit: db.ticks[i.id].length ? db.ticks[i.id][db.ticks[i.id].length-1].digit : 0
      })));
    }

    /* ---- TRADES ---- */
    if (p === '/api/trades' && method === 'POST') {
      if (!u) return sendJSON(res, 401, { error:'Unauthorized' });
      const b = await readBody(req);
      const account = b.account === 'demo' ? 'demo' : 'real';
      const stake = Number(b.stake);
      const duration = Math.max(1, Math.min(10, Number(b.duration) || 5));
      if (!(stake >= 1)) return sendJSON(res, 400, { error:'Minimum stake is $1' });
      const balance = account === 'demo' ? (u.demoBalance ?? 10000) : (u.balance || 0);
      if (stake > balance) return sendJSON(res, 400, { error:'Insufficient balance' });
      const idx = INDICES[b.index];
      if (!idx) return sendJSON(res, 400, { error:'Unknown index' });
      if (!ODDS[b.kind]) return sendJSON(res, 400, { error:'Unknown kind' });
      const pred = Number(b.prediction);
      if (['matches','differs','over','under'].includes(b.kind) && (pred < 0 || pred > 9 || !Number.isInteger(pred)))
        return sendJSON(res, 400, { error:'Prediction must be 0-9' });

      const tick = db.ticks[b.index][db.ticks[b.index].length-1];
      const odds = ODDS[b.kind](pred);
      const t = {
        id: crypto.randomUUID(), userId: u.id, account, index: b.index,
        kind: b.kind, prediction: pred, stake,
        entryDigit: tick.digit, entryPrice: tick.price,
        ticksLeft: duration,
        openedAt: Date.now(), expiresAt: Date.now() + duration*1000,
        status:'open', profit:0, odds
      };
      db.trades.push(t);
      if (account === 'demo') u.demoBalance = +(u.demoBalance - stake).toFixed(2);
      else u.balance = +(u.balance - stake).toFixed(2);
      db.txs.push({
        id: crypto.randomUUID(), userId: u.id, account,
        type:'trade_stake', amount:-stake, ref:t.id,
        status:'completed', createdAt: Date.now()
      });
      save();
      return sendJSON(res, 200, { trade: t, balance: account === 'demo' ? u.demoBalance : u.balance });
    }

    if (p === '/api/trades' && method === 'GET') {
      if (!u) return sendJSON(res, 401, { error:'Unauthorized' });
      const acct = parsed.query.account;
      let list = db.trades.filter(t => t.userId === u.id);
      if (acct === 'demo' || acct === 'real') list = list.filter(t => t.account === acct);
      return sendJSON(res, 200, list.sort((a,b)=>b.openedAt-a.openedAt).slice(0,100));
    }

    /* ---- M-PESA DEPOSIT via ZETUPAY ---- */
    if (p === '/api/deposits/mpesa' && method === 'POST') {
      if (!u) return sendJSON(res, 401, { error:'Unauthorized' });
      const b = await readBody(req);
      const amt = Number(b.amount);
      if (!(amt >= 5)) return sendJSON(res, 400, { error:'Minimum $5' });
      const kes = Math.round(amt * USD_KES);
      let phone = String(b.phone || '').replace(/\D/g,'');
      if (phone.startsWith('0')) phone = '254' + phone.slice(1);
      if (phone.startsWith('7') || phone.startsWith('1')) phone = '254' + phone;
      if (!/^254[17]\d{8}$/.test(phone)) return sendJSON(res, 400, { error:'Invalid Kenyan phone' });

      const txId = crypto.randomUUID();
      const reference = 'TOK' + txId.slice(0,8).toUpperCase();
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const redirectUrl = proto + '://' + host + '/payment/return';

      const tx = {
        id: txId, userId: u.id, type:'deposit', method:'mpesa',
        amount: amt, kesAmount: kes, phone, reference,
        status:'pending', createdAt: Date.now()
      };
      db.txs.push(tx); save();

      try {
        const r = await zetupayInitiate({ phone, amountKes: kes, reference, redirectUrl });
        if (r.demo) {
          tx.status = 'completed'; tx.demo = true;
          u.balance = +((u.balance||0) + amt).toFixed(2); save();
          return sendJSON(res, 200, { txId, reference, kes, demo:true });
        }
        tx.paymentKey = r.paymentKey;
        tx.checkoutUrl = r.checkoutUrl;
        save();
        return sendJSON(res, 200, { txId, reference, kes, checkoutUrl: r.checkoutUrl });
      } catch(e) {
        tx.status = 'failed'; tx.reason = e.message; save();
        return sendJSON(res, 500, { error: e.message });
      }
    }

    /* ---- ZETUPAY WEBHOOK ---- */
    if (p === '/api/webhooks/zetupay' && method === 'POST') {
      try {
        const secret = req.headers['x-zetupay-secret'];
        if (ZETUPAY_SECRET_KEY && secret && secret !== ZETUPAY_SECRET_KEY) {
          return sendJSON(res, 401, { error:'bad sig' });
        }
        const b = await readBody(req);
        if (b.event === 'payment.success' && b.data) {
          const ref = b.data.reference;
          const key = b.data.paymentKey;
          const tx = db.txs.find(t => (ref && t.reference === ref) || (key && t.paymentKey === key));
          if (tx && tx.status !== 'completed') {
            tx.status = 'completed';
            tx.receiptNumber = b.data.receiptNumber || null;
            tx.paidAt = Date.now();
            const user = findUserById(tx.userId);
            if (user) user.balance = +((user.balance||0) + tx.amount).toFixed(2);
            save();
          }
        }
        return sendJSON(res, 200, { ok:true });
      } catch { return sendJSON(res, 200, { ok:true }); }
    }

    /* ---- Deposit status (polling) ---- */
    if (p.startsWith('/api/deposits/status/') && method === 'GET') {
      if (!u) return sendJSON(res, 401, { error:'Unauthorized' });
      const txId = p.replace('/api/deposits/status/','');
      const tx = db.txs.find(t => t.id === txId && t.userId === u.id);
      if (!tx) return sendJSON(res, 404, { error:'Not found' });
      if (tx.status === 'pending' && tx.paymentKey) {
        const st = await zetupayStatus(tx.paymentKey);
        if (st && st.status === 'success' && tx.status !== 'completed') {
          tx.status = 'completed'; tx.paidAt = Date.now();
          tx.receiptNumber = st.receiptNumber || null;
          const user = findUserById(tx.userId);
          if (user) user.balance = +((user.balance||0) + tx.amount).toFixed(2);
          save();
        } else if (st && (st.status === 'failed' || st.status === 'cancelled')) {
          tx.status = st.status; tx.reason = st.status; save();
        }
      }
      return sendJSON(res, 200, { status: tx.status, amount: tx.amount });
    }

    /* ---- CRYPTO DEPOSIT (USDT TRC20) ---- */
    if (p === '/api/deposits/crypto' && method === 'POST') {
      if (!u) return sendJSON(res, 401, { error:'Unauthorized' });
      const b = await readBody(req);
      const amt = Number(b.amount);
      if (b.currency !== 'USDT_TRC20') return sendJSON(res, 400, { error:'Only USDT TRC20' });
      if (!(amt >= 5)) return sendJSON(res, 400, { error:'Minimum $5' });
      const ref = 'TOK-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const tx = {
        id: crypto.randomUUID(), userId: u.id, type:'deposit', method:'crypto',
        currency:'USDT_TRC20', amount: amt, address: USDT_ADDRESS,
        reference: ref, status:'pending', createdAt: Date.now()
      };
      db.txs.push(tx); save();
      return sendJSON(res, 200, { txId: tx.id, address: USDT_ADDRESS, reference: ref, amount: amt });
    }

    if (p === '/api/deposits/crypto/claim' && method === 'POST') {
      if (!u) return sendJSON(res, 401, { error:'Unauthorized' });
      const b = await readBody(req);
      const tx = db.txs.find(t => t.id === b.txId && t.userId === u.id);
      if (!tx) return sendJSON(res, 404, { error:'Not found' });
      tx.status = 'confirming'; tx.claimedAt = Date.now();
      if (DEMO_MODE) {
        setTimeout(() => {
          const fresh = db.txs.find(t => t.id === tx.id);
          if (!fresh || fresh.status === 'completed') return;
          fresh.status = 'completed'; fresh.confirmedAt = Date.now();
          const usr = findUserById(fresh.userId);
          if (usr) usr.balance = +((usr.balance||0) + fresh.amount).toFixed(2);
          save();
        }, 5000);
      }
      save();
      return sendJSON(res, 200, { ok:true });
    }

    /* ---- Admin confirm crypto ---- */
    if (p === '/api/admin/confirm-crypto' && method === 'POST') {
      if (req.headers['x-admin-key'] !== ADMIN_KEY) return sendJSON(res, 401, { error:'Unauthorized' });
      const b = await readBody(req);
      const tx = db.txs.find(t => t.id === b.txId);
      if (!tx) return sendJSON(res, 404, { error:'Not found' });
      if (tx.status === 'completed') return sendJSON(res, 200, { ok:true, already:true });
      tx.status = 'completed'; tx.confirmedAt = Date.now();
      const usr = findUserById(tx.userId);
      if (usr) usr.balance = +((usr.balance||0) + tx.amount).toFixed(2);
      save();
      return sendJSON(res, 200, { ok:true });
    }

    /* ---- TRANSACTIONS ---- */
    if (p === '/api/transactions' && method === 'GET') {
      if (!u) return sendJSON(res, 401, { error:'Unauthorized' });
      const acct = parsed.query.account;
      let list = db.txs.filter(t => t.userId === u.id);
      if (acct === 'demo' || acct === 'real') list = list.filter(t => (t.account || 'real') === acct);
      return sendJSON(res, 200, list.sort((a,b)=>b.createdAt-a.createdAt).slice(0,100));
    }

    /* ---- WITHDRAWALS ---- */
    if (p === '/api/withdrawals' && method === 'POST') {
      if (!u) return sendJSON(res, 401, { error:'Unauthorized' });
      const b = await readBody(req);
      const amt = Number(b.amount);
      if (!(amt >= 10)) return sendJSON(res, 400, { error:'Minimum $10' });
      if (amt > (u.balance||0)) return sendJSON(res, 400, { error:'Insufficient balance' });
      if (!b.destination) return sendJSON(res, 400, { error:'Destination required' });
      const tx = {
        id: crypto.randomUUID(), userId: u.id, type:'withdrawal', account:'real',
        method: b.method, amount: amt, destination: b.destination,
        status:'pending', createdAt: Date.now()
      };
      db.txs.push(tx);
      u.balance = +(u.balance - amt).toFixed(2);
      save();
      return sendJSON(res, 200, { tx, balance: u.balance });
    }

    /* ---- Demo top-up ---- */
    if (p === '/api/demo/reset' && method === 'POST') {
      if (!u) return sendJSON(res, 401, { error:'Unauthorized' });
      u.demoBalance = 10000;
      save();
      return sendJSON(res, 200, { demoBalance: u.demoBalance });
    }

    return sendJSON(res, 404, { error:'not found: ' + p });
  } catch(e) {
    console.error('err:', e);
    try { sendJSON(res, 500, { error: e.message }); } catch {}
  }
});

/* ===================== FRONTEND ===================== */
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#0a0e17">
<title>TaqOptionKe — Digit Trading</title>
<style>
:root{--bg:#0a0e17;--card:#131824;--card2:#1a2030;--line:rgba(255,255,255,.06);--line2:rgba(255,255,255,.1);--tx:#e5e7eb;--tx2:#9ca3af;--tx3:#6b7280;--blue:#2563eb;--blue2:#3b82f6;--blueGlow:0 0 20px rgba(59,130,246,.45);--green:#22c55e;--greenGlow:0 0 24px rgba(34,197,94,.4);--red:#ef4444;--redGlow:0 0 24px rgba(239,68,68,.4);--purple:#8b5cf6;--amber:#f59e0b;--orange:#f97316}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{height:100%;overflow-x:hidden}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.4;-webkit-font-smoothing:antialiased}
button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}
input,select{font-family:inherit;outline:none;border:none;background:none;color:inherit}
canvas{display:block}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace}

/* AUTH */
#authScreen{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:radial-gradient(circle at 20% 20%,rgba(37,99,235,.15),transparent 50%),radial-gradient(circle at 80% 80%,rgba(139,92,246,.12),transparent 50%)}
.auth-box{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.auth-logo{width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,#ef4444,#b91c1c);display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;color:#fff;margin:0 auto 18px;box-shadow:var(--redGlow)}
.auth-title{text-align:center;font-size:22px;font-weight:800;margin-bottom:6px}
.auth-sub{text-align:center;color:var(--tx2);font-size:13px;margin-bottom:22px}
.auth-field{margin-bottom:14px}
.auth-field label{display:block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--tx3);margin-bottom:6px}
.auth-field input{width:100%;padding:13px;background:rgba(0,0,0,.35);border:1.5px solid var(--line2);border-radius:11px;font-size:14px;color:var(--tx)}
.auth-field input:focus{border-color:var(--blue2);box-shadow:0 0 0 3px rgba(59,130,246,.15)}
.auth-btn{width:100%;padding:14px;background:linear-gradient(135deg,var(--blue2),var(--blue));border-radius:11px;font-weight:800;font-size:14px;color:#fff;box-shadow:var(--blueGlow);margin-top:8px}
.auth-btn:disabled{opacity:.6}
.auth-switch{text-align:center;margin-top:18px;color:var(--tx2);font-size:13px}
.auth-switch button{color:var(--blue2);font-weight:700}
.auth-error{color:var(--red);font-size:12px;margin-top:10px;text-align:center;min-height:16px}

/* APP */
#app{min-height:100vh;display:none;flex-direction:column;padding-bottom:76px}
.topbar{position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:8px;padding:10px 12px;background:rgba(10,14,23,.97);backdrop-filter:blur(20px);border-bottom:1px solid var(--line)}
.hamburger{width:32px;height:32px;border-radius:8px;font-size:17px;display:flex;align-items:center;justify-content:center;color:var(--tx2)}
.brand{width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,#ef4444,#b91c1c);display:flex;align-items:center;justify-content:center;font-weight:900;color:#fff;font-size:15px;box-shadow:0 0 16px rgba(239,68,68,.5);flex-shrink:0}
.acct-chip{display:flex;align-items:center;gap:6px;padding:6px 10px 6px 5px;border-radius:99px;background:rgba(37,99,235,.12);border:1px solid rgba(59,130,246,.3);font-size:12px;font-weight:700;cursor:pointer}
.acct-chip.demo{background:rgba(245,158,11,.15);border-color:rgba(245,158,11,.4);color:#fbbf24}
.acct-dot{width:8px;height:8px;border-radius:50%;background:var(--blue2);flex-shrink:0}
.acct-chip.demo .acct-dot{background:var(--amber)}
.chip-bal{font-variant-numeric:tabular-nums}
.chip-arrow{font-size:8px;opacity:.7}
.tb-spacer{flex:1}
.icon-btn{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--tx2)}
.icon-btn:hover{background:var(--card2);color:var(--tx)}
.dep-btn{padding:8px 14px;border-radius:9px;background:linear-gradient(135deg,var(--blue2),var(--blue));font-weight:800;font-size:12px;color:#fff;box-shadow:var(--blueGlow)}

/* Index tabs */
.idx-scroll{display:flex;gap:6px;padding:10px 12px 4px;overflow-x:auto;scrollbar-width:none}
.idx-scroll::-webkit-scrollbar{display:none}
.idx-chip{flex-shrink:0;padding:7px 12px;border-radius:9px;background:var(--card);border:1px solid var(--line);font-size:12px;font-weight:700;color:var(--tx2);transition:.2s}
.idx-chip.active{background:linear-gradient(135deg,rgba(59,130,246,.2),rgba(37,99,235,.15));border-color:var(--blue2);color:var(--blue2);box-shadow:var(--blueGlow)}

/* Chart */
.chart-wrap{margin:10px 12px 0;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.chart-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:rgba(0,0,0,.25);border-bottom:1px solid var(--line)}
.chart-head .sym{font-size:12px;font-weight:700;display:flex;align-items:center;gap:6px}
.chart-head .sym .live{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);animation:pulse 1.4s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.chart-price{font-size:13px;font-weight:800;font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:8px}
.last-digit-pill{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 6px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#2563eb);font-size:15px;font-weight:900;color:#fff;box-shadow:0 0 14px rgba(59,130,246,.6);font-variant-numeric:tabular-nums}
.chart-canvas{position:relative;height:200px}
#chart{width:100%;height:100%}

/* Digit ring */
.digit-ring{display:grid;grid-template-columns:repeat(10,1fr);gap:4px;padding:12px}
.digit-cell{display:flex;flex-direction:column;align-items:center;gap:3px}
.digit-circle{width:30px;height:30px;border-radius:50%;border:2px solid var(--line2);background:var(--card2);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;transition:all .3s;position:relative}
.digit-circle.current{border-color:var(--blue2);background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;box-shadow:0 0 14px rgba(59,130,246,.7);transform:scale(1.08)}
.digit-cell.hot .digit-circle{border-color:var(--green);color:var(--green)}
.digit-cell.cold .digit-circle{border-color:var(--red);color:var(--red)}
.digit-cell.hot .digit-circle.current,.digit-cell.cold .digit-circle.current{color:#fff}
.digit-pct{font-size:9px;font-weight:700;color:var(--tx3);font-variant-numeric:tabular-nums}
.digit-cell.hot .digit-pct{color:var(--green)}
.digit-cell.cold .digit-pct{color:var(--red)}

/* Contract tabs */
.c-tabs{display:flex;gap:6px;padding:6px 12px 0;overflow-x:auto;scrollbar-width:none}
.c-tabs::-webkit-scrollbar{display:none}
.c-tab{flex-shrink:0;padding:8px 14px;border-radius:10px;background:var(--card);border:1px solid var(--line);font-size:12px;font-weight:700;color:var(--tx2);transition:.2s}
.c-tab.active{background:linear-gradient(135deg,rgba(59,130,246,.2),rgba(37,99,235,.15));border-color:var(--blue2);color:var(--blue2);box-shadow:var(--blueGlow)}

/* Panel */
.panel{padding:12px}
.panel .pick-row{margin-bottom:12px}
.panel .pick-label{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--tx3);margin-bottom:6px}
.digits-pick{display:grid;grid-template-columns:repeat(10,1fr);gap:5px}
.digits-pick button{padding:10px 2px;border-radius:9px;background:var(--card);border:1.5px solid var(--line2);font-size:15px;font-weight:800;color:var(--tx);transition:.2s}
.digits-pick button.active{background:linear-gradient(135deg,#3b82f6,#2563eb);border-color:var(--blue2);color:#fff;box-shadow:0 0 16px rgba(59,130,246,.6)}

.stake-row{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.stake-btn{width:44px;height:44px;border-radius:11px;background:var(--card2);border:1px solid var(--line2);font-size:20px;font-weight:700;color:var(--tx);display:flex;align-items:center;justify-content:center}
.stake-display{flex:1;height:52px;background:linear-gradient(135deg,rgba(37,99,235,.08),rgba(59,130,246,.05));border:1.5px solid var(--blue2);border-radius:12px;display:flex;align-items:center;justify-content:center;gap:3px;font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;box-shadow:0 0 20px rgba(59,130,246,.25),inset 0 0 20px rgba(59,130,246,.06)}
.stake-display .cur{font-size:17px;color:var(--blue2);font-weight:600}

.quick-amts{display:grid;grid-template-columns:repeat(6,1fr);gap:5px;margin-bottom:12px}
.quick-amts button{padding:9px 2px;border-radius:9px;background:var(--card);border:1px solid var(--line);font-size:11px;font-weight:800;color:var(--tx2);transition:.2s}
.quick-amts button.active{background:linear-gradient(135deg,rgba(59,130,246,.2),rgba(37,99,235,.15));border-color:var(--blue2);color:var(--blue2);box-shadow:var(--blueGlow)}

.dur-row{display:flex;gap:6px;margin-bottom:12px;overflow-x:auto;scrollbar-width:none}
.dur-row::-webkit-scrollbar{display:none}
.dur-row button{flex-shrink:0;padding:8px 12px;border-radius:9px;background:var(--card);border:1px solid var(--line);font-size:11px;font-weight:800;color:var(--tx2);transition:.2s}
.dur-row button.active{background:linear-gradient(135deg,rgba(245,158,11,.2),rgba(245,158,11,.12));border-color:var(--amber);color:var(--amber);box-shadow:0 0 16px rgba(245,158,11,.4)}

.trade-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.trade-btn{padding:14px 12px;border-radius:13px;font-weight:800;text-align:left;display:flex;flex-direction:column;gap:2px;transition:.2s}
.trade-btn:active{transform:scale(.98)}
.trade-btn .ttl{font-size:17px;line-height:1.2}
.trade-btn .sub{font-size:10px;opacity:.8;display:flex;justify-content:space-between;margin-top:3px}
.trade-btn .payout{font-size:14px;font-weight:800;font-variant-numeric:tabular-nums}
.trade-btn.green{background:linear-gradient(135deg,#16a34a,#22c55e);color:#fff;box-shadow:var(--greenGlow)}
.trade-btn.red{background:linear-gradient(135deg,#dc2626,#ef4444);color:#fff;box-shadow:var(--redGlow)}
.trade-btn.blue{background:linear-gradient(135deg,#2563eb,#3b82f6);color:#fff;box-shadow:var(--blueGlow)}
.trade-btn.amber{background:linear-gradient(135deg,#d97706,#f59e0b);color:#fff;box-shadow:0 0 20px rgba(245,158,11,.4)}

/* Bottom nav */
.bnav{position:fixed;bottom:0;left:0;right:0;z-index:60;display:grid;grid-template-columns:repeat(3,1fr);background:rgba(13,18,32,.98);backdrop-filter:blur(20px);border-top:1px solid var(--line);padding:6px 6px 8px}
.bnav button{display:flex;flex-direction:column;align-items:center;gap:2px;padding:7px 4px;border-radius:9px;font-size:10px;font-weight:700;color:var(--tx3);transition:.2s}
.bnav button .bi{font-size:18px}
.bnav button.active{color:var(--blue2)}

/* Views */
.view{display:none}
.view.active{display:block}

/* Positions */
.pos-list{padding:12px;display:flex;flex-direction:column;gap:9px}
.pos-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
.pos-card .row{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.pos-card .row:last-child{margin-bottom:0}
.pos-sym{font-weight:800;font-size:13px;display:flex;align-items:center;gap:6px}
.pos-badge{padding:3px 9px;border-radius:99px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.05em}
.pos-badge.won{background:rgba(34,197,94,.15);color:var(--green);border:1px solid rgba(34,197,94,.3)}
.pos-badge.lost{background:rgba(239,68,68,.15);color:var(--red);border:1px solid rgba(239,68,68,.3)}
.pos-badge.open{background:rgba(59,130,246,.15);color:var(--blue2);border:1px solid rgba(59,130,246,.3)}
.pos-meta{display:flex;justify-content:space-between;font-size:11px;color:var(--tx2);margin-top:5px}
.pos-meta b{color:var(--tx);font-weight:700}
.pos-meta .pl.win{color:var(--green);font-weight:800}
.pos-meta .pl.loss{color:var(--red);font-weight:800}
.empty{text-align:center;padding:50px 20px;color:var(--tx3)}
.empty .ic{font-size:40px;margin-bottom:10px;opacity:.5}

/* Drawer */
.backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:100;opacity:0;pointer-events:none;transition:.28s}
.backdrop.show{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;left:0;bottom:0;width:82%;max-width:340px;background:#0d1220;z-index:110;transform:translateX(-100%);transition:transform .32s cubic-bezier(.4,0,.2,1);overflow-y:auto;box-shadow:20px 0 60px rgba(0,0,0,.6)}
.drawer.show{transform:translateX(0)}
.dr-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line)}
.dr-head .t{font-size:15px;font-weight:800}
.dr-head .x{font-size:20px;color:var(--tx2);padding:4px}
.dr-user{display:flex;align-items:center;gap:12px;padding:16px;border-bottom:1px solid var(--line)}
.dr-user .av{width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,var(--blue2),var(--blue));display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:800;color:#fff;flex-shrink:0}
.dr-user .info .n{font-weight:800;font-size:14px}
.dr-user .info .e{font-size:11px;color:var(--tx2);margin-top:1px}
.dr-item{display:flex;align-items:center;gap:12px;padding:14px 16px;transition:.2s;cursor:pointer;border-bottom:1px solid var(--line)}
.dr-item:hover{background:var(--card)}
.dr-item .ic{width:22px;text-align:center;font-size:16px;color:var(--tx2)}
.dr-item .lbl{flex:1;font-size:13px;font-weight:600}
.dr-item .arw{color:var(--tx3);font-size:12px}
.dr-item.danger .ic,.dr-item.danger .lbl{color:var(--red)}
.dr-foot{padding:18px;text-align:center;color:var(--tx3);font-size:10px;font-variant-numeric:tabular-nums}

/* Modals */
.modal{position:fixed;inset:0;z-index:200;display:none;align-items:flex-end;justify-content:center}
.modal.show{display:flex}
.modal-bg{position:absolute;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px)}
.modal-card{position:relative;width:100%;max-width:520px;background:#0d1220;border-top-left-radius:22px;border-top-right-radius:22px;max-height:88vh;overflow-y:auto;animation:slideUp .32s cubic-bezier(.4,0,.2,1);border-top:1px solid var(--line2)}
@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
.modal-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 10px;position:sticky;top:0;background:#0d1220;z-index:2}
.modal-head .t{font-size:18px;font-weight:800}
.modal-head .s{font-size:11px;color:var(--tx2);margin-top:2px}
.modal-head .x{font-size:20px;color:var(--tx2);padding:4px}
.modal-body{padding:0 20px 20px}
.modal-foot{display:flex;align-items:center;justify-content:center;gap:16px;padding:12px;border-top:1px solid var(--line);color:var(--tx3);font-size:10px}
.modal-foot span{display:flex;align-items:center;gap:5px}
.modal-foot .dot{width:4px;height:4px;border-radius:50%;background:var(--blue2);box-shadow:0 0 6px var(--blue2)}

.pay-opt{display:flex;align-items:center;gap:12px;padding:14px;background:var(--card);border:1.5px solid var(--line);border-radius:13px;margin-bottom:9px;cursor:pointer;transition:.22s}
.pay-opt.sel{border-color:var(--blue2);box-shadow:var(--blueGlow)}
.pay-opt .pi{width:42px;height:42px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:19px;flex-shrink:0}
.pay-opt[data-m="mpesa"] .pi{background:rgba(34,197,94,.15);color:var(--green)}
.pay-opt[data-m="usdt"] .pi{background:rgba(38,161,123,.2);color:#26a17b;font-weight:900;font-size:13px}
.pay-opt .pt{flex:1}
.pay-opt .pt .n{font-weight:800;font-size:14px}
.pay-opt .pt .s{font-size:11px;color:var(--tx2);margin-top:1px}
.pay-opt .pa{color:var(--tx3);font-size:14px}

.ff{margin-bottom:12px}
.ff label{display:block;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--tx3);margin-bottom:6px}
.ff input,.ff select{width:100%;padding:13px;background:rgba(0,0,0,.35);border:1.5px solid var(--line2);border-radius:11px;font-size:14px;color:var(--tx)}
.ff input:focus{border-color:var(--blue2)}
.ff select option{background:#0d1220;color:var(--tx)}

.amt-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:14px}
.amt-grid button{padding:12px;border-radius:10px;background:var(--card);border:1px solid var(--line);font-size:13px;font-weight:800;color:var(--tx2);transition:.2s}
.amt-grid button.active{background:linear-gradient(135deg,rgba(59,130,246,.2),rgba(37,99,235,.15));border-color:var(--blue2);color:var(--blue2);box-shadow:var(--blueGlow)}

.primary-btn{width:100%;padding:14px;border-radius:11px;background:linear-gradient(135deg,var(--blue2),var(--blue));color:#fff;font-weight:800;font-size:14px;box-shadow:var(--blueGlow);margin-top:4px}
.primary-btn.red{background:linear-gradient(135deg,#dc2626,#ef4444);box-shadow:var(--redGlow)}

.result-box{padding:14px;border-radius:13px;margin-top:12px;font-size:12px;line-height:1.55}
.result-box.ok{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.3)}
.result-box.warn{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3)}
.result-box .t{font-weight:800;font-size:14px;margin-bottom:6px}
.result-box .t.ok{color:var(--green)}.result-box .t.warn{color:var(--red)}
.result-box code{display:block;word-break:break-all;background:#000;padding:10px;border-radius:7px;font-family:ui-monospace,monospace;font-size:11px;margin-top:7px;color:#60a5fa;border:1px solid var(--line)}

/* Toast */
#toast{position:fixed;bottom:96px;left:50%;transform:translate(-50%,150%);z-index:400;background:rgba(19,24,36,.98);border:1.5px solid var(--blue2);border-radius:11px;padding:12px 18px;font-size:12px;font-weight:700;box-shadow:0 0 26px rgba(59,130,246,.5);transition:transform .35s cubic-bezier(.4,0,.2,1);max-width:88%;text-align:center;backdrop-filter:blur(12px)}
#toast.show{transform:translate(-50%,0)}
#toast.success{border-color:var(--green);box-shadow:0 0 26px rgba(34,197,94,.5)}
#toast.error{border-color:var(--red);box-shadow:0 0 26px rgba(239,68,68,.5)}

/* History item */
.hist-item{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line)}
.hist-item:last-child{border-bottom:none}
.hist-ic{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
.hist-ic.win{background:rgba(34,197,94,.15);color:var(--green)}
.hist-ic.loss{background:rgba(239,68,68,.15);color:var(--red)}
.hist-ic.dep{background:rgba(59,130,246,.15);color:var(--blue2)}
.hist-ic.wd{background:rgba(245,158,11,.15);color:var(--amber)}
.hist-info{flex:1;min-width:0}
.hist-info .t{font-weight:700;font-size:12px}
.hist-info .s{font-size:10px;color:var(--tx3);margin-top:1px}
.hist-amt{font-weight:800;font-size:13px;font-variant-numeric:tabular-nums}
.hist-amt.pos{color:var(--green)}
.hist-amt.neg{color:var(--red)}
</style>
</head>
<body>

<!-- AUTH -->
<div id="authScreen">
  <div class="auth-box">
    <div class="auth-logo">T</div>
    <h1 class="auth-title" id="authTitle">Welcome to TaqOptionKe</h1>
    <p class="auth-sub" id="authSub">Digit trading on Volatility Indices</p>
    <form id="authForm" onsubmit="return false">
      <div class="auth-field" id="nameField" style="display:none"><label>Full Name</label><input type="text" id="authName" placeholder="John Doe"></div>
      <div class="auth-field"><label>Email</label><input type="email" id="authEmail" placeholder="you@example.com" required autocomplete="email"></div>
      <div class="auth-field"><label>Password</label><input type="password" id="authPassword" placeholder="Minimum 6 characters" required autocomplete="current-password"></div>
      <button type="submit" class="auth-btn" id="authBtn">Sign In</button>
      <div class="auth-error" id="authError"></div>
    </form>
    <p class="auth-switch"><span id="switchText">Don't have an account?</span> <button type="button" id="switchBtn">Create one</button></p>
  </div>
</div>

<!-- APP -->
<div id="app">
  <header class="topbar">
    <button class="hamburger" onclick="openDrawer()">☰</button>
    <div class="brand">T</div>
    <button class="acct-chip" id="acctChip" onclick="openModal('acctModal')">
      <span class="acct-dot"></span>
      <span class="chip-bal" id="navBalance">$0.00</span>
      <span class="chip-arrow">▼</span>
    </button>
    <div class="tb-spacer"></div>
    <button class="icon-btn" id="soundBtn">🔊</button>
    <button class="dep-btn" onclick="openDeposit()">Deposit</button>
  </header>

  <!-- Index tabs -->
  <div class="idx-scroll" id="idxTabs"></div>

  <!-- Chart -->
  <div class="chart-wrap">
    <div class="chart-head">
      <div class="sym"><span class="live"></span><span id="chSym">Vol 10 (1s)</span></div>
      <div class="chart-price">
        <span class="mono" id="chPrice">9534.43</span>
        <span class="last-digit-pill mono" id="chDigit">3</span>
      </div>
    </div>
    <div class="chart-canvas"><canvas id="chart"></canvas></div>
  </div>

  <!-- Digit ring -->
  <div class="digit-ring" id="digitRing"></div>

  <!-- Contract tabs -->
  <div class="c-tabs" id="cTabs">
    <button class="c-tab" data-tab="matches">Matches/Differs</button>
    <button class="c-tab active" data-tab="evenodd">Even/Odd</button>
    <button class="c-tab" data-tab="overunder">Over/Under</button>
  </div>

  <!-- Trade panel -->
  <div class="panel" id="tradePanel"></div>
</div>

<!-- POSITIONS VIEW -->
<div class="view" id="view-positions" style="min-height:100vh">
  <div class="topbar" style="position:sticky">
    <button class="hamburger" onclick="switchView('trade')">←</button>
    <div style="font-size:16px;font-weight:800;flex:1">Positions</div>
    <div style="font-size:11px;color:var(--tx2)" id="posSummary">—</div>
  </div>
  <div class="pos-list" id="positionsList"><div class="empty"><div class="ic">📋</div><div>No trades yet</div></div></div>
</div>

<!-- BOTTOM NAV -->
<nav class="bnav">
  <button class="active" data-view="trade" onclick="switchView('trade')"><span class="bi">📊</span><span>Trade</span></button>
  <button data-view="positions" onclick="switchView('positions')"><span class="bi">🕐</span><span>Positions</span></button>
  <button onclick="openDrawer()"><span class="bi">☰</span><span>Menu</span></button>
</nav>

<!-- DRAWER -->
<div class="backdrop" id="drawerBackdrop" onclick="closeDrawer()"></div>
<aside class="drawer" id="drawer">
  <div class="dr-head"><span class="t">Menu</span><button class="x" onclick="closeDrawer()">✕</button></div>
  <div class="dr-user"><div class="av" id="drawerAvatar">U</div><div class="info"><div class="n" id="drawerName">Guest</div><div class="e" id="drawerEmail">not signed in</div></div></div>
  <div class="dr-item" onclick="closeDrawer();openDeposit()"><span class="ic">⬇</span><span class="lbl">Deposit</span></div>
  <div class="dr-item" onclick="closeDrawer();openWithdraw()"><span class="ic">⬆</span><span class="lbl">Withdraw</span></div>
  <div class="dr-item" onclick="closeDrawer();openHistory()"><span class="ic">🕐</span><span class="lbl">History</span></div>
  <div class="dr-item" onclick="closeDrawer();resetDemo()"><span class="ic">🎮</span><span class="lbl">Reset Demo Balance</span></div>
  <div class="dr-item" onclick="closeDrawer();toast('Refer & Earn coming soon')"><span class="ic">🎁</span><span class="lbl">Refer &amp; Earn</span><span class="arw">›</span></div>
  <div class="dr-item" onclick="closeDrawer();toast('Help Centre coming soon')"><span class="ic">❓</span><span class="lbl">Help Centre</span><span class="arw">›</span></div>
  <div class="dr-item danger" onclick="logout()"><span class="ic">⏻</span><span class="lbl">Log out</span></div>
  <div class="dr-foot mono" id="drTime"></div>
</aside>

<!-- ACCOUNT MODAL -->
<div class="modal" id="acctModal">
  <div class="modal-bg" onclick="closeModal('acctModal')"></div>
  <div class="modal-card" style="max-width:400px;border-radius:16px;margin:auto">
    <div class="modal-head"><div><div class="t">Choose Account</div><div class="s">Switch between real and demo</div></div><button class="x" onclick="closeModal('acctModal')">✕</button></div>
    <div class="modal-body">
      <div class="pay-opt" data-acct="real" onclick="setAccount('real')">
        <div class="pi" style="background:rgba(37,99,235,.15);color:var(--blue2)">R</div>
        <div class="pt"><div class="n">Real Account</div><div class="s">Balance: <span id="realBal">$0.00</span></div></div>
        <div class="pa" id="realCheck">○</div>
      </div>
      <div class="pay-opt" data-acct="demo" onclick="setAccount('demo')">
        <div class="pi" style="background:rgba(245,158,11,.15);color:var(--amber)">D</div>
        <div class="pt"><div class="n">Demo Account</div><div class="s">Balance: <span id="demoBal">$10,000.00</span></div></div>
        <div class="pa" id="demoCheck">○</div>
      </div>
    </div>
  </div>
</div>

<!-- DEPOSIT MODAL -->
<div class="modal" id="depositModal">
  <div class="modal-bg" onclick="closeModal('depositModal')"></div>
  <div class="modal-card">
    <div class="modal-head"><div><div class="t">Deposit Funds</div><div class="s">Choose your payment method</div></div><button class="x" onclick="closeModal('depositModal')">✕</button></div>
    <div class="modal-body">
      <div class="pay-opt sel" data-m="mpesa" onclick="pickPay(this)"><div class="pi">📱</div><div class="pt"><div class="n">M-Pesa</div><div class="s">Instant mobile money</div></div><div class="pa">↗</div></div>
      <div class="pay-opt" data-m="usdt" onclick="pickPay(this)"><div class="pi">₮</div><div class="pt"><div class="n">USDT (TRC20)</div><div class="s">Cryptocurrency · TRON</div></div><div class="pa">↗</div></div>
      <div class="ff" style="margin-top:14px"><label>Amount (USD)</label><input type="number" id="depAmount" value="10" min="5" oninput="updateDepAmts()"></div>
      <div class="amt-grid" id="depAmtGrid">
        <button data-amt="5" onclick="setDepAmt(this,5)">$5</button>
        <button data-amt="10" class="active" onclick="setDepAmt(this,10)">$10</button>
        <button data-amt="25" onclick="setDepAmt(this,25)">$25</button>
        <button data-amt="50" onclick="setDepAmt(this,50)">$50</button>
        <button data-amt="100" onclick="setDepAmt(this,100)">$100</button>
        <button data-amt="250" onclick="setDepAmt(this,250)">$250</button>
      </div>
      <div class="ff" id="mpesaPhoneField"><label>M-Pesa Phone Number</label><input type="tel" id="mpesaPhone" placeholder="0712345678"></div>
      <button class="primary-btn" onclick="submitDeposit()">Continue</button>
      <div id="depositResult"></div>
    </div>
    <div class="modal-foot"><span><span class="dot"></span>Secure</span><span><span class="dot"></span>Instant</span><span><span class="dot"></span>24/7</span></div>
  </div>
</div>

<!-- WITHDRAW MODAL -->
<div class="modal" id="withdrawModal">
  <div class="modal-bg" onclick="closeModal('withdrawModal')"></div>
  <div class="modal-card">
    <div class="modal-head"><div><div class="t">Withdraw Funds</div><div class="s">Real account only</div></div><button class="x" onclick="closeModal('withdrawModal')">✕</button></div>
    <div class="modal-body">
      <div class="ff"><label>Withdraw To</label><select id="wdMethod"><option value="mpesa">M-Pesa</option><option value="usdt">USDT (TRC20)</option></select></div>
      <div class="ff"><label>Destination</label><input type="text" id="wdDest" placeholder="0712345678 or TRC20 address"></div>
      <div class="ff"><label>Amount (USD)</label><input type="number" id="wdAmount" value="10" min="10"></div>
      <button class="primary-btn red" onclick="submitWithdraw()">Request Withdrawal</button>
      <div id="withdrawResult"></div>
    </div>
    <div class="modal-foot"><span><span class="dot"></span>24h processing</span><span><span class="dot"></span>Zero fees</span></div>
  </div>
</div>

<!-- HISTORY MODAL -->
<div class="modal" id="historyModal">
  <div class="modal-bg" onclick="closeModal('historyModal')"></div>
  <div class="modal-card">
    <div class="modal-head"><div><div class="t">History</div><div class="s">Your transactions</div></div><button class="x" onclick="closeModal('historyModal')">✕</button></div>
    <div class="modal-body" id="historyBody"><div class="empty"><div class="ic">📋</div><div>No history yet</div></div></div>
  </div>
</div>

<div id="toast"></div>

<script>
(function(){
'use strict';

/* ================= STATE ================= */
var S = {
  token: localStorage.getItem('tok_token'),
  user: null,
  account: 'real',
  indices: [],
  activeIndex: 'vol10',
  ticks: {},
  activeTab: 'evenodd',
  prediction: 5,
  barrier: 4,
  stake: 10,
  duration: 5,
  positions: [],
  sound: true,
  zoom: 1
};

/* ================= API ================= */
function api(path, opts){
  opts = opts || {};
  var h = { 'Content-Type':'application/json' };
  if (S.token) h['Authorization'] = 'Bearer ' + S.token;
  if (opts.headers) for (var k in opts.headers) h[k] = opts.headers[k];
  return fetch(path, Object.assign({}, opts, { headers: h })).then(function(r){
    return r.json().catch(function(){return{}}).then(function(d){
      if (!r.ok) throw new Error(d.error || 'Request failed');
      return d;
    });
  });
}

/* ================= AUTH ================= */
var authMode = 'login';
function setupAuth(){
  var t = document.getElementById('authTitle'), sub = document.getElementById('authSub'),
      nf = document.getElementById('nameField'), st = document.getElementById('switchText'),
      sb = document.getElementById('switchBtn'), ab = document.getElementById('authBtn');
  document.getElementById('authError').textContent = '';
  if (authMode === 'login') {
    t.textContent = 'Welcome Back'; sub.textContent = 'Sign in to start trading digits';
    nf.style.display = 'none'; st.textContent = "Don't have an account?"; sb.textContent = 'Create one'; ab.textContent = 'Sign In';
  } else {
    t.textContent = 'Create Account'; sub.textContent = 'Join TaqOptionKe in 30 seconds';
    nf.style.display = 'block'; st.textContent = 'Already have an account?'; sb.textContent = 'Sign in'; ab.textContent = 'Create Account';
  }
}
document.getElementById('switchBtn').onclick = function(){ authMode = authMode === 'login' ? 'register' : 'login'; setupAuth(); };
document.getElementById('authForm').onsubmit = function(e){
  e.preventDefault();
  var err = document.getElementById('authError'), btn = document.getElementById('authBtn');
  err.textContent = ''; btn.disabled = true;
  var email = document.getElementById('authEmail').value.trim().toLowerCase();
  var pw = document.getElementById('authPassword').value;
  if (pw.length < 6) { err.textContent = 'Password must be 6+ characters'; btn.disabled = false; return; }
  var pr;
  if (authMode === 'register') {
    var name = document.getElementById('authName').value.trim() || 'Trader';
    pr = api('/api/auth/register', { method:'POST', body: JSON.stringify({ name: name, email: email, password: pw }) });
  } else {
    pr = api('/api/auth/login', { method:'POST', body: JSON.stringify({ email: email, password: pw }) });
  }
  pr.then(function(d){
    S.token = d.token; localStorage.setItem('tok_token', d.token);
    S.user = d.user;
    enterApp();
    toast(authMode === 'register' ? 'Account created ✓' : 'Welcome back ✓', 'success');
  }).catch(function(e2){ err.textContent = e2.message })
    .then(function(){ btn.disabled = false; setupAuth(); });
};
function tryRestore(){
  if (!S.token) return Promise.resolve();
  return api('/api/me').then(function(u){ S.user = u; enterApp(); }).catch(function(){ S.token = null; localStorage.removeItem('tok_token'); });
}
function logout(){
  S.token = null; S.user = null; localStorage.removeItem('tok_token');
  closeDrawer();
  document.getElementById('app').style.display = 'none';
  document.getElementById('authScreen').style.display = 'flex';
  if (window._tickTimer) { clearInterval(window._tickTimer); window._tickTimer = null; }
  if (window._es) { window._es.close(); window._es = null; }
  authMode = 'login'; setupAuth(); toast('Signed out');
}

/* ================= ENTER APP ================= */
function enterApp(){
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('view-positions').classList.add('view');
  var initials = (S.user.name || 'U').split(' ').map(function(x){return x[0];}).join('').slice(0,2).toUpperCase();
  document.getElementById('drawerAvatar').textContent = initials;
  document.getElementById('drawerName').textContent = S.user.name;
  document.getElementById('drawerEmail').textContent = (S.user.email || '').replace(/^(.{2}).*(@.*)$/, '$1***$2');
  updateBalanceUI();
  buildIndexTabs();
  startSSE();
  startClock();
  refreshPositions();
  setInterval(refreshPositions, 3000);
}

/* ================= BALANCE UI ================= */
function updateBalanceUI(){
  if (!S.user) return;
  var bal = S.account === 'demo' ? (S.user.demoBalance || 0) : (S.user.balance || 0);
  document.getElementById('navBalance').textContent = '$' + bal.toFixed(2);
  document.getElementById('realBal').textContent = '$' + (S.user.balance || 0).toFixed(2);
  document.getElementById('demoBal').textContent = '$' + (S.user.demoBalance || 0).toFixed(2);
  var chip = document.getElementById('acctChip');
  chip.classList.toggle('demo', S.account === 'demo');
  document.getElementById('realCheck').textContent = S.account === 'real' ? '●' : '○';
  document.getElementById('demoCheck').textContent = S.account === 'demo' ? '●' : '○';
  document.getElementById('realCheck').style.color = S.account === 'real' ? 'var(--blue2)' : '';
  document.getElementById('demoCheck').style.color = S.account === 'demo' ? 'var(--amber)' : '';
  renderTradePanel();
}
function setAccount(a){
  S.account = a;
  updateBalanceUI();
  closeModal('acctModal');
  toast(a === 'demo' ? 'Demo account active' : 'Real account active');
}
function refreshUser(){
  return api('/api/me').then(function(u){ S.user = u; updateBalanceUI(); }).catch(function(){});
}
function resetDemo(){
  api('/api/demo/reset', { method:'POST' }).then(function(r){
    S.user.demoBalance = r.demoBalance;
    updateBalanceUI();
    toast('Demo balance reset to $10,000');
  }).catch(function(e){ toast(e.message, 'error'); });
}

/* ================= INDEX TABS ================= */
function buildIndexTabs(){
  api('/api/indices').then(function(list){
    S.indices = list;
    var box = document.getElementById('idxTabs');
    box.innerHTML = list.map(function(i){
      return '<button class="idx-chip' + (i.id === S.activeIndex ? ' active' : '') + '" onclick="TQ.setIndex(\'' + i.id + '\')">' + i.name + '</button>';
    }).join('');
    updateChartHeader();
  }).catch(function(){});
}
function setIndex(id){
  S.activeIndex = id;
  document.querySelectorAll('.idx-chip').forEach(function(b){ b.classList.toggle('active', b.textContent.toLowerCase().indexOf(id.replace('vol','vol ')) !== -1 || b.textContent.indexOf(id.replace('vol','Vol ')) !== -1); });
  // fallback: match by order
  var idxList = S.indices.map(function(i){return i.id;});
  document.querySelectorAll('.idx-chip').forEach(function(b, i){
    b.classList.toggle('active', idxList[i] === id);
  });
  updateChartHeader();
  drawChart();
  renderDigitRing();
}
function updateChartHeader(){
  var i = S.indices.find(function(x){ return x.id === S.activeIndex; });
  if (i) document.getElementById('chSym').textContent = i.name;
}

/* ================= SSE STREAM ================= */
function startSSE(){
  if (window._es) window._es.close();
  var es = new EventSource('/api/stream');
  window._es = es;
  es.addEventListener('init', function(e){
    var d = JSON.parse(e.data);
    S.ticks = d.ticks;
    onTick();
  });
  es.addEventListener('tick', function(e){
    var d = JSON.parse(e.data);
    if (!S.ticks[d.index]) S.ticks[d.index] = [];
    S.ticks[d.index].push(d.tick);
    if (S.ticks[d.index].length > 400) S.ticks[d.index].shift();
    if (d.index === S.activeIndex) onTick();
  });
  es.onerror = function(){
    es.close();
    setTimeout(startSSE, 3000);
  };
}
function currentTick(){
  var arr = S.ticks[S.activeIndex] || [];
  return arr[arr.length-1] || { price: 9534.43, digit: 3 };
}
function onTick(){
  var t = currentTick();
  document.getElementById('chPrice').textContent = t.price.toFixed(2);
  document.getElementById('chDigit').textContent = t.digit;
  drawChart();
  renderDigitRing();
  settleLocalExpired();
}

/* ================= CHART ================= */
var chart = document.getElementById('chart');
var ctx = chart.getContext('2d');
var dpr = window.devicePixelRatio || 1;
function resizeChart(){
  var r = chart.parentElement.getBoundingClientRect();
  chart.width = r.width * dpr;
  chart.height = r.height * dpr;
  chart.style.width = r.width + 'px';
  chart.style.height = r.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawChart();
}
window.addEventListener('resize', resizeChart);
function drawChart(){
  var w = chart.width / dpr, h = chart.height / dpr;
  if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);
  var data = (S.ticks[S.activeIndex] || []).slice(-80);
  if (data.length < 2) return;

  var padR = 56, padB = 20, padT = 8, padL = 8;
  var cw = w - padR - padL, ch = h - padB - padT;

  var hi = -Infinity, lo = Infinity;
  data.forEach(function(t){ if (t.price > hi) hi = t.price; if (t.price < lo) lo = t.price; });
  var rng = (hi - lo) || 1;
  hi += rng * 0.1; lo -= rng * 0.1;
  var total = hi - lo;

  var xOf = function(i){ return padL + (cw / (data.length - 1)) * i; };
  var yOf = function(p){ return padT + (1 - (p - lo) / total) * ch; };

  // grid
  ctx.strokeStyle = 'rgba(255,255,255,.04)'; ctx.lineWidth = 1;
  for (var j = 0; j <= 4; j++) {
    var y = padT + (ch / 4) * j;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
  }
  ctx.font = '10px ui-monospace, monospace'; ctx.textAlign = 'left';
  for (var k = 0; k <= 4; k++) {
    var yy = padT + (ch / 4) * k;
    var v = hi - (total / 4) * k;
    ctx.fillStyle = 'rgba(156,163,175,.65)';
    ctx.fillText(v.toFixed(2), padL + cw + 6, yy + 3);
  }

  // fill
  ctx.beginPath();
  data.forEach(function(t, i){
    var x = xOf(i), y = yOf(t.price);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.lineTo(xOf(data.length - 1), padT + ch);
  ctx.lineTo(xOf(0), padT + ch);
  ctx.closePath();
  var grad = ctx.createLinearGradient(0, padT, 0, padT + ch);
  grad.addColorStop(0, 'rgba(59,130,246,.22)');
  grad.addColorStop(1, 'rgba(59,130,246,0)');
  ctx.fillStyle = grad;
  ctx.fill();

  // line
  ctx.beginPath();
  data.forEach(function(t, i){
    var x = xOf(i), y = yOf(t.price);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#60a5fa';
  ctx.lineWidth = 1.8;
  ctx.shadowColor = '#3b82f6';
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // last dot
  var lastD = data[data.length - 1];
  var lx = xOf(data.length - 1), ly = yOf(lastD.price);
  ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fillStyle = '#60a5fa'; ctx.fill();
  ctx.beginPath(); ctx.arc(lx, ly, 8, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(96,165,250,.5)'; ctx.stroke();

  // price label
  var label = lastD.price.toFixed(2);
  ctx.font = 'bold 11px ui-monospace, monospace';
  var tw = ctx.measureText(label).width + 10;
  ctx.fillStyle = '#3b82f6';
  ctx.fillRect(padL + cw + 2, ly - 9, tw, 18);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
  ctx.fillText(label, padL + cw + 7, ly + 3.5);

  // time labels
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(156,163,175,.5)';
  for (var n = 0; n <= 4; n++) {
    var idx = Math.floor((data.length - 1) * (n / 4));
    var t = new Date(data[idx].time);
    var str = t.toTimeString().slice(0, 8);
    ctx.textAlign = n === 0 ? 'left' : n === 4 ? 'right' : 'center';
    ctx.fillText(str, xOf(idx), h - 5);
  }
}

/* ================= DIGIT RING ================= */
function renderDigitRing(){
  var ring = document.getElementById('digitRing');
  var recent = (S.ticks[S.activeIndex] || []).slice(-100);
  if (!recent.length) { ring.innerHTML = ''; return; }
  var counts = [0,0,0,0,0,0,0,0,0,0];
  recent.forEach(function(t){ counts[t.digit]++; });
  var current = recent[recent.length - 1].digit;
  var total = recent.length;
  var html = '';
  for (var d = 0; d < 10; d++) {
    var pct = (counts[d] / total) * 100;
    var cls = '';
    if (pct >= 12) cls = 'hot';
    else if (pct <= 8) cls = 'cold';
    html += '<div class="digit-cell ' + cls + '">' +
      '<div class="digit-circle' + (d === current ? ' current' : '') + '">' + d + '</div>' +
      '<div class="digit-pct">' + pct.toFixed(1) + '%</div>' +
      '</div>';
  }
  ring.innerHTML = html;
}

/* ================= CONTRACT TABS ================= */
document.querySelectorAll('#cTabs .c-tab').forEach(function(btn){
  btn.onclick = function(){
    document.querySelectorAll('#cTabs .c-tab').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    S.activeTab = btn.dataset.tab;
    renderTradePanel();
  };
});

/* ================= TRADE PANEL ================= */
function payoutFor(kind, pred, stake){
  var odds;
  switch (kind) {
    case 'matches': odds = 9.0; break;
    case 'differs': odds = 1.05; break;
    case 'even':    odds = 1.952; break;
    case 'odd':     odds = 1.952; break;
    case 'over':    odds = 1 + (9 - pred) / 10 + 0.08; break;
    case 'under':   odds = 1 + pred / 10 + 0.08; break;
    default: odds = 1.95;
  }
  return { odds: odds, payout: stake * odds };
}

function renderTradePanel(){
  var panel = document.getElementById('tradePanel');
  var stake = S.stake;

  var baseHtml = '';
  baseHtml += '<div class="stake-row">' +
    '<button class="stake-btn" onclick="TQ.adjustStake(-1)">−</button>' +
    '<div class="stake-display"><span class="cur">$</span><span id="stakeVal">' + stake + '</span></div>' +
    '<button class="stake-btn" onclick="TQ.adjustStake(1)">+</button>' +
    '</div>';

  baseHtml += '<div class="quick-amts" id="quickAmts">' +
    [1,5,10,25,50,100].map(function(a){
      return '<button class="' + (a === stake ? 'active' : '') + '" onclick="TQ.setStake(' + a + ')">$' + a + '</button>';
    }).join('') +
    '</div>';

  baseHtml += '<div class="pick-row" style="margin-bottom:8px"><div class="pick-label">Duration</div>' +
    '<div class="dur-row">' +
    [1,3,5,10].map(function(d){
      return '<button class="' + (d === S.duration ? 'active' : '') + '" onclick="TQ.setDuration(' + d + ')">' + d + 's</button>';
    }).join('') +
    '</div></div>';

  var panelBody = '';

  if (S.activeTab === 'evenodd') {
    var pEven = payoutFor('even', 0, stake);
    var pOdd = payoutFor('odd', 0, stake);
    panelBody = '<div class="trade-btns">' +
      '<button class="trade-btn green" onclick="TQ.buy(\'even\')">' +
        '<div class="ttl">Even</div>' +
        '<div class="sub"><span>95.2%</span><span class="payout">$' + pEven.payout.toFixed(2) + '</span></div>' +
      '</button>' +
      '<button class="trade-btn red" onclick="TQ.buy(\'odd\')">' +
        '<div class="ttl">Odd</div>' +
        '<div class="sub"><span>95.2%</span><span class="payout">$' + pOdd.payout.toFixed(2) + '</span></div>' +
      '</button>' +
      '</div>';
  } else if (S.activeTab === 'matches') {
    var matchPay = payoutFor('matches', S.prediction, stake);
    var diffPay = payoutFor('differs', S.prediction, stake);
    panelBody =
      '<div class="pick-row"><div class="pick-label">Predict digit</div>' +
      '<div class="digits-pick">' +
      [0,1,2,3,4,5,6,7,8,9].map(function(d){
        return '<button class="' + (d === S.prediction ? 'active' : '') + '" onclick="TQ.setPrediction(' + d + ')">' + d + '</button>';
      }).join('') +
      '</div></div>' +
      '<div class="trade-btns">' +
      '<button class="trade-btn blue" onclick="TQ.buy(\'matches\')">' +
        '<div class="ttl">Matches ' + S.prediction + '</div>' +
        '<div class="sub"><span>9.0×</span><span class="payout">$' + matchPay.payout.toFixed(2) + '</span></div>' +
      '</button>' +
      '<button class="trade-btn blue" onclick="TQ.buy(\'differs\')">' +
        '<div class="ttl">Differs ' + S.prediction + '</div>' +
        '<div class="sub"><span>1.05×</span><span class="payout">$' + diffPay.payout.toFixed(2) + '</span></div>' +
      '</button>' +
      '</div>';
  } else if (S.activeTab === 'overunder') {
    var overPay = payoutFor('over', S.barrier, stake);
    var underPay = payoutFor('under', S.barrier, stake);
    panelBody =
      '<div class="pick-row"><div class="pick-label">Barrier</div>' +
      '<div class="digits-pick">' +
      [0,1,2,3,4,5,6,7,8,9].map(function(d){
        return '<button class="' + (d === S.barrier ? 'active' : '') + '" onclick="TQ.setBarrier(' + d + ')">' + d + '</button>';
      }).join('') +
      '</div></div>' +
      '<div class="trade-btns">' +
      '<button class="trade-btn amber" onclick="TQ.buy(\'under\')">' +
        '<div class="ttl">Under ' + S.barrier + '</div>' +
        '<div class="sub"><span>' + ((underPay.odds - 1) * 100).toFixed(1) + '%</span><span class="payout">$' + underPay.payout.toFixed(2) + '</span></div>' +
      '</button>' +
      '<button class="trade-btn amber" onclick="TQ.buy(\'over\')">' +
        '<div class="ttl">Over ' + S.barrier + '</div>' +
        '<div class="sub"><span>' + ((overPay.odds - 1) * 100).toFixed(1) + '%</span><span class="payout">$' + overPay.payout.toFixed(2) + '</span></div>' +
      '</button>' +
      '</div>';
  }

  panel.innerHTML = baseHtml + panelBody;
}

/* ================= BUY ================= */
function buy(kind){
  if (!S.user) { toast('Please sign in', 'error'); return; }
  var bal = S.account === 'demo' ? (S.user.demoBalance || 0) : (S.user.balance || 0);
  if (S.stake > bal) { toast('Insufficient balance. Deposit or switch to Demo.', 'error'); return; }
  var prediction = ['matches','differs','over','under'].includes(kind) ? (kind === 'over' || kind === 'under' ? S.barrier : S.prediction) : 0;

  api('/api/trades', {
    method: 'POST',
    body: JSON.stringify({
      account: S.account,
      index: S.activeIndex,
      kind: kind,
      prediction: prediction,
      stake: S.stake,
      duration: S.duration
    })
  }).then(function(r){
    if (S.account === 'demo') S.user.demoBalance = r.balance;
    else S.user.balance = r.balance;
    updateBalanceUI();
    toast(kindLabel(kind, prediction) + ' • $' + S.stake + ' • ' + S.duration + 's', 'success');
    refreshPositions();
  }).catch(function(e){ toast(e.message, 'error'); });
}

function kindLabel(kind, pred){
  if (kind === 'even') return 'Even';
  if (kind === 'odd') return 'Odd';
  if (kind === 'matches') return 'Matches ' + pred;
  if (kind === 'differs') return 'Differs ' + pred;
  if (kind === 'over') return 'Over ' + pred;
  if (kind === 'under') return 'Under ' + pred;
  return kind;
}

/* ================= POSITIONS ================= */
function refreshPositions(){
  if (!S.token) return;
  api('/api/trades').then(function(list){
    S.positions = list;
    renderPositions();
  }).catch(function(){});
}

function renderPositions(){
  var list = document.getElementById('positionsList');
  var open = S.positions.filter(function(p){ return p.status === 'open'; }).length;
  document.getElementById('posSummary').textContent = open ? open + ' open' : 'No open';
  if (!S.positions.length) {
    list.innerHTML = '<div class="empty"><div class="ic">📋</div><div>No trades yet</div></div>';
    return;
  }
  var html = '';
  S.positions.slice(0, 40).forEach(function(p){
    var badge = p.status === 'open'
      ? '<span class="pos-badge open">Open</span>'
      : p.status === 'won' ? '<span class="pos-badge won">Won</span>' : '<span class="pos-badge lost">Lost</span>';
    var plClass = p.status === 'open' ? '' : (p.profit >= 0 ? 'win' : 'loss');
    var plText = p.status === 'open' ? ('$' + p.stake.toFixed(2))
      : (p.profit >= 0 ? '+$' : '-$') + Math.abs(p.profit).toFixed(2);
    html += '<div class="pos-card">' +
      '<div class="row"><span class="pos-sym">' + kindLabel(p.kind, p.prediction) + ' <span style="color:var(--tx3);font-weight:500;font-size:11px">· ' + (INDICES_MAP[p.index] || p.index) + '</span></span>' + badge + '</div>' +
      '<div class="pos-meta"><span>Entry: <b>' + p.entryDigit + '</b></span><span>Exit: <b>' + (p.exitDigit != null ? p.exitDigit : '—') + '</b></span></div>' +
      '<div class="pos-meta"><span>Stake: <b>$' + p.stake.toFixed(2) + '</b></span><span class="pl ' + plClass + '">' + plText + '</span></div>' +
      '</div>';
  });
  list.innerHTML = html;
}

var INDICES_MAP = {
  vol10: 'Vol 10', vol25: 'Vol 25', vol50: 'Vol 50', vol75: 'Vol 75', vol100: 'Vol 100'
};

/* Local expiry UI (server settles authoritatively) */
function settleLocalExpired(){ /* no-op; server handles */ }

/* ================= VIEW ================= */
function switchView(name){
  document.querySelectorAll('.view, #app').forEach(function(v){ v.classList.remove('active'); });
  if (name === 'trade') document.getElementById('app').classList.add('active');
  else document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.bnav button').forEach(function(b){ b.classList.toggle('active', b.dataset.view === name); });
  if (name === 'positions') refreshPositions();
}

/* ================= DRAWER ================= */
function openDrawer(){ document.getElementById('drawer').classList.add('show'); document.getElementById('drawerBackdrop').classList.add('show'); }
function closeDrawer(){ document.getElementById('drawer').classList.remove('show'); document.getElementById('drawerBackdrop').classList.remove('show'); }
function startClock(){
  var el = document.getElementById('drTime');
  function t(){ el.textContent = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, ' GMT'); }
  t(); setInterval(t, 1000);
}
document.getElementById('soundBtn').onclick = function(){ S.sound = !S.sound; this.textContent = S.sound ? '🔊' : '🔇'; };

/* ================= MODALS ================= */
function openModal(id){ document.getElementById(id).classList.add('show'); }
function closeModal(id){ document.getElementById(id).classList.remove('show'); }
function openDeposit(){ document.getElementById('depositResult').innerHTML = ''; openModal('depositModal'); }
function openWithdraw(){ document.getElementById('withdrawResult').innerHTML = ''; openModal('withdrawModal'); }
function openHistory(){ loadHistory(); openModal('historyModal'); }

/* ================= DEPOSIT ================= */
var depositMethod = 'mpesa';
function pickPay(el){
  document.querySelectorAll('#depositModal .pay-opt').forEach(function(o){ o.classList.remove('sel'); });
  el.classList.add('sel');
  depositMethod = el.dataset.m;
  document.getElementById('mpesaPhoneField').style.display = depositMethod === 'mpesa' ? 'block' : 'none';
}
function setDepAmt(el, v){
  document.querySelectorAll('#depAmtGrid button').forEach(function(b){ b.classList.remove('active'); });
  el.classList.add('active');
  document.getElementById('depAmount').value = v;
}
function updateDepAmts(){
  var v = +document.getElementById('depAmount').value;
  document.querySelectorAll('#depAmtGrid button').forEach(function(b){ b.classList.toggle('active', +b.dataset.amt === v); });
}
function submitDeposit(){
  var amount = parseFloat(document.getElementById('depAmount').value);
  var box = document.getElementById('depositResult');
  if (!(amount >= 5)) { toast('Minimum deposit is $5', 'error'); return; }

  if (depositMethod === 'mpesa') {
    var phone = document.getElementById('mpesaPhone').value.trim();
    if (!phone) { toast('Enter your M-Pesa number', 'error'); return; }
    box.innerHTML = '<div class="result-box"><div class="t" style="color:var(--tx2)">⏳ Creating payment session…</div></div>';
    api('/api/deposits/mpesa', { method:'POST', body: JSON.stringify({ phone: phone, amount: amount }) })
      .then(function(r){
        if (r.demo) {
          box.innerHTML = '<div class="result-box ok"><div class="t ok">✓ Deposit Confirmed (Demo)</div>$' + amount.toFixed(2) + ' added to your balance.<div style="margin-top:6px;font-size:10px;color:var(--tx3)">Set ZETUPAY_SECRET_KEY in env for real payments.</div></div>';
          refreshUser();
        } else {
          box.innerHTML = '<div class="result-box ok"><div class="t ok">📲 Opening checkout…</div>You will enter your M-Pesa PIN.<div style="margin-top:6px;font-size:10px;color:var(--tx3)">Ref: ' + r.reference + ' · KES ' + r.kes + '</div><div style="margin-top:8px;font-size:11px" id="pollStatus">⏳ Waiting for confirmation…</div></div>';
          pollDeposit(r.txId);
          if (r.checkoutUrl) setTimeout(function(){ window.location.href = r.checkoutUrl; }, 900);
        }
      })
      .catch(function(e){ box.innerHTML = '<div class="result-box warn"><div class="t warn">⚠ Error</div>' + e.message + '</div>'; });
  }
  if (depositMethod === 'usdt') {
    box.innerHTML = '<div class="result-box"><div class="t" style="color:var(--tx2)">⏳ Generating address…</div></div>';
    api('/api/deposits/crypto', { method:'POST', body: JSON.stringify({ currency: 'USDT_TRC20', amount: amount }) })
      .then(function(r){
        box.innerHTML = '<div class="result-box ok"><div class="t ok">₮ Send USDT (TRC20)</div>Send exactly <b>' + amount.toFixed(2) + ' USDT</b> to:<code>' + r.address + '</code><div style="margin-top:8px;font-size:10px;color:var(--tx3)">Network: TRON only · Ref: ' + r.reference + '</div><button class="primary-btn" style="margin-top:10px" onclick="TQ.claimCrypto(\'' + r.txId + '\')">I\'ve sent the crypto</button></div>';
      })
      .catch(function(e){ box.innerHTML = '<div class="result-box warn"><div class="t warn">⚠ Error</div>' + e.message + '</div>'; });
  }
}
function claimCrypto(txId){
  api('/api/deposits/crypto/claim', { method:'POST', body: JSON.stringify({ txId: txId }) })
    .then(function(){ toast('Claim submitted ✓ Awaiting confirmation', 'success'); pollDeposit(txId); })
    .catch(function(e){ toast(e.message, 'error'); });
}
function pollDeposit(txId){
  var el = document.getElementById('pollStatus'); if (!el) return;
  var iv = setInterval(function(){
    api('/api/deposits/status/' + txId).then(function(r){
      if (r.status === 'completed') {
        clearInterval(iv);
        el.innerHTML = '<span style="color:var(--green)">✓ Confirmed! $' + r.amount.toFixed(2) + ' added.</span>';
        refreshUser();
      } else if (r.status === 'failed' || r.status === 'cancelled') {
        clearInterval(iv);
        el.innerHTML = '<span style="color:var(--red)">✗ Payment ' + r.status + '.</span>';
      }
    }).catch(function(){});
  }, 3000);
}
function submitWithdraw(){
  var method = document.getElementById('wdMethod').value;
  var dest = document.getElementById('wdDest').value.trim();
  var amount = parseFloat(document.getElementById('wdAmount').value);
  var box = document.getElementById('withdrawResult');
  if (!dest) { toast('Enter destination', 'error'); return; }
  if (!(amount >= 10)) { toast('Minimum is $10', 'error'); return; }
  api('/api/withdrawals', { method:'POST', body: JSON.stringify({ method: method, amount: amount, destination: dest }) })
    .then(function(r){
      S.user.balance = r.balance;
      updateBalanceUI();
      box.innerHTML = '<div class="result-box ok"><div class="t ok">✓ Withdrawal Requested</div>$' + amount.toFixed(2) + ' to ' + dest + '. Processed within 24 hours.</div>';
      toast('Withdrawal requested ✓', 'success');
    })
    .catch(function(e){ box.innerHTML = '<div class="result-box warn"><div class="t warn">⚠ Error</div>' + e.message + '</div>'; });
}

/* ================= HISTORY ================= */
function loadHistory(){
  var body = document.getElementById('historyBody');
  api('/api/transactions').then(function(txs){
    if (!txs.length) { body.innerHTML = '<div class="empty"><div class="ic">📋</div><div>No history yet</div></div>'; return; }
    var html = '';
    txs.forEach(function(t){
      var m;
      if (t.type === 'deposit') m = { ic:'⬇', cls:'dep', label:'Deposit' };
      else if (t.type === 'withdrawal') m = { ic:'⬆', cls:'wd', label:'Withdrawal' };
      else if (t.type === 'trade_stake') m = { ic:'🎯', cls:'loss', label:'Trade stake' };
      else if (t.type === 'trade_win') m = { ic:'🏆', cls:'win', label:'Trade win' };
      else if (t.type === 'trade_loss') m = { ic:'📉', cls:'loss', label:'Trade loss' };
      else m = { ic:'•', cls:'dep', label: t.type };
      var sign = t.amount >= 0 ? '+' : '-';
      var cls = t.amount >= 0 ? 'pos' : 'neg';
      html += '<div class="hist-item">' +
        '<div class="hist-ic ' + m.cls + '">' + m.ic + '</div>' +
        '<div class="hist-info"><div class="t">' + m.label + '</div><div class="s">' + new Date(t.createdAt).toLocaleString() + ' · ' + t.status + '</div></div>' +
        '<div class="hist-amt ' + cls + '">' + sign + '$' + Math.abs(t.amount).toFixed(2) + '</div>' +
        '</div>';
    });
    body.innerHTML = html;
  }).catch(function(e){ body.innerHTML = '<div class="empty"><div class="ic">⚠</div><div>' + e.message + '</div></div>'; });
}

/* ================= TOAST ================= */
var toastTimer;
function toast(msg, kind){
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.className = '';
  if (kind) el.classList.add(kind);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.remove('show'); }, 2400);
}

/* ================= HELPERS ================= */
function adjustStake(dir){
  var steps = [1,2,5,10,25,50,100,250,500,1000];
  var i = steps.indexOf(S.stake);
  if (i === -1) { for (var j = 0; j < steps.length; j++) { if (steps[j] > S.stake) { i = j; break; } } if (i === -1) i = steps.length - 1; }
  i = Math.max(0, Math.min(steps.length - 1, i + dir));
  S.stake = steps[i];
  renderTradePanel();
}
function setStake(v){ S.stake = v; renderTradePanel(); }
function setDuration(v){ S.duration = v; renderTradePanel(); }
function setPrediction(d){ S.prediction = d; renderTradePanel(); }
function setBarrier(d){ S.barrier = d; renderTradePanel(); }

/* ================= EXPOSE TO HTML ================= */
window.TQ = {
  setIndex: setIndex, adjustStake: adjustStake, setStake: setStake,
  setDuration: setDuration, setPrediction: setPrediction, setBarrier: setBarrier,
  buy: buy, claimCrypto: claimCrypto
};
window.openDrawer = openDrawer; window.closeDrawer = closeDrawer;
window.openModal = openModal; window.closeModal = closeModal;
window.openDeposit = openDeposit; window.openWithdraw = openWithdraw; window.openHistory = openHistory;
window.switchView = switchView; window.setAccount = setAccount; window.resetDemo = resetDemo;
window.pickPay = pickPay; window.setDepAmt = setDepAmt; window.updateDepAmts = updateDepAmts;
window.submitDeposit = submitDeposit; window.submitWithdraw = submitWithdraw; window.logout = logout;

/* ================= BOOT ================= */
setupAuth();
tryRestore();
resizeChart();
window.addEventListener('load', function(){ setTimeout(resizeChart, 100); });
})();
</script>
</body>
</html>`;

/* ===================== BOOT ===================== */
server.listen(PORT, () => {
  console.log('\n⚡ TaqOptionKe live on port ' + PORT);
  console.log('   Demo mode: ' + DEMO_MODE);
  console.log('   ZetuPay: ' + (ZETUPAY_SECRET_KEY ? 'CONFIGURED ✓' : 'not set (deposits use demo)'));
  console.log('   USDT address: ' + USDT_ADDRESS);
  console.log('');
});
