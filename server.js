const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const FINMIND_TOKEN = process.env.FINMIND_TOKEN;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const BASE = 'https://api.finmindtrade.com/api/v4/data';

app.use(cors());
app.use(express.json());

// ── 記憶體儲存（免費方案無持久化）──────────────
let notifySettings = {}; // { email, watchlist, alerts:[{code,targetPrice,direction}] }

// ── Gmail 設定 ────────────────────────────────
function createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
  });
}

async function sendMail(to, subject, html) {
  if (!GMAIL_USER || !GMAIL_PASS) throw new Error('Gmail 未設定');
  const t = createTransporter();
  await t.sendMail({ from: `台股分析儀 <${GMAIL_USER}>`, to, subject, html });
}

// ── 工具函式 ──────────────────────────────────
async function fm(params) {
  const url = new URL(BASE);
  url.searchParams.set('token', FINMIND_TOKEN);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
  const r = await fetch(url.toString());
  const d = await r.json();
  if (d.status !== 200) throw new Error(d.msg || 'FinMind error');
  return d.data;
}

function daysAgo(n) {
  return new Date(Date.now()-n*86400000).toISOString().slice(0,10);
}

async function getLatestPrice(code) {
  const data = await fm({ dataset:'TaiwanStockPrice', data_id:code, start_date:daysAgo(10) });
  if (!data.length) return null;
  const last=data[data.length-1], prev=data.length>1?data[data.length-2]:last;
  const change = +(last.close-prev.close).toFixed(2);
  return { code, price:last.close, change, changePct:+((change/prev.close)*100).toFixed(2), date:last.date };
}

// ── 每日收盤摘要（台股收盤約 13:30，14:00 發送）
async function sendDailySummary() {
  const settings = Object.values(notifySettings);
  if (!settings.length) return;

  for (const s of settings) {
    if (!s.email || !s.watchlist || !s.watchlist.length || !s.dailySummary) continue;
    try {
      const prices = await Promise.allSettled(s.watchlist.map(getLatestPrice));
      const rows = prices
        .filter(r => r.status==='fulfilled' && r.value)
        .map(r => r.value)
        .map(p => `
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:8px 12px;font-weight:500">${p.code}</td>
            <td style="padding:8px 12px;font-family:monospace">${p.price}</td>
            <td style="padding:8px 12px;color:${p.change>=0?'#16a34a':'#dc2626'};font-family:monospace">
              ${p.change>=0?'+':''}${p.change} (${p.change>=0?'+':''}${p.changePct}%)
            </td>
          </tr>`).join('');

      const html = `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
          <div style="background:#0b120b;padding:16px 20px;border-radius:8px 8px 0 0">
            <h2 style="color:#4dd87a;margin:0;font-size:16px">台股分析儀 — 每日收盤摘要</h2>
            <p style="color:#3a5a3a;margin:4px 0 0;font-size:12px">${new Date().toLocaleDateString('zh-TW')}</p>
          </div>
          <div style="background:#f9f9f9;padding:16px 20px">
            <table style="width:100%;border-collapse:collapse">
              <thead>
                <tr style="background:#e8f5e9">
                  <th style="padding:8px 12px;text-align:left;font-size:12px;color:#3a5a3a">代號</th>
                  <th style="padding:8px 12px;text-align:left;font-size:12px;color:#3a5a3a">收盤價</th>
                  <th style="padding:8px 12px;text-align:left;font-size:12px;color:#3a5a3a">漲跌</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <div style="background:#f0f0f0;padding:10px 20px;border-radius:0 0 8px 8px;font-size:11px;color:#888">
            ⚠ 本郵件由台股分析儀自動發送，資料僅供參考，不構成投資建議。
          </div>
        </div>`;

      await sendMail(s.email, `台股收盤摘要 ${new Date().toLocaleDateString('zh-TW')}`, html);
      console.log(`Daily summary sent to ${s.email}`);
    } catch(e) {
      console.error(`Failed to send to ${s.email}:`, e.message);
    }
  }
}

// ── 目標價警示檢查 ────────────────────────────
async function checkPriceAlerts() {
  const settings = Object.values(notifySettings);
  for (const s of settings) {
    if (!s.email || !s.alerts || !s.alerts.length) continue;
    for (const alert of s.alerts) {
      if (alert.triggered) continue;
      try {
        const p = await getLatestPrice(alert.code);
        if (!p) continue;
        const hit = alert.direction==='above' ? p.price>=alert.targetPrice : p.price<=alert.targetPrice;
        if (!hit) continue;

        const html = `
          <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
            <div style="background:#${alert.direction==='above'?'0b120b':'3a0a0a'};padding:16px 20px;border-radius:8px 8px 0 0">
              <h2 style="color:${alert.direction==='above'?'#4dd87a':'#f87171'};margin:0;font-size:16px">
                台股分析儀 — 目標價${alert.direction==='above'?'突破':'跌破'}提醒
              </h2>
            </div>
            <div style="background:#f9f9f9;padding:20px;text-align:center">
              <div style="font-size:28px;font-family:monospace;font-weight:700;color:#1a1a1a">${alert.code}</div>
              <div style="font-size:14px;color:#666;margin:4px 0">目前價格</div>
              <div style="font-size:36px;font-family:monospace;color:${alert.direction==='above'?'#16a34a':'#dc2626'};font-weight:700">${p.price}</div>
              <div style="font-size:13px;color:#888;margin-top:8px">
                已${alert.direction==='above'?'突破':'跌破'}目標價 ${alert.targetPrice}
              </div>
              <div style="font-size:12px;color:${p.change>=0?'#16a34a':'#dc2626'};margin-top:4px">
                今日漲跌：${p.change>=0?'+':''}${p.change} (${p.change>=0?'+':''}${p.changePct}%)
              </div>
            </div>
            <div style="background:#f0f0f0;padding:10px 20px;border-radius:0 0 8px 8px;font-size:11px;color:#888">
              ⚠ 本郵件由台股分析儀自動發送，資料僅供參考，不構成投資建議。
            </div>
          </div>`;

        await sendMail(s.email, `【台股提醒】${alert.code} 已${alert.direction==='above'?'突破':'跌破'} ${alert.targetPrice}`, html);
        alert.triggered = true;
        console.log(`Alert sent: ${alert.code} ${alert.direction} ${alert.targetPrice}`);
      } catch(e) {
        console.error(`Alert check failed for ${alert.code}:`, e.message);
      }
    }
  }
}

// ── 定時任務 ──────────────────────────────────
// 每天 14:00 台灣時間（UTC+8）= UTC 06:00 發送收盤摘要
cron.schedule('0 6 * * 1-5', sendDailySummary);
// 每 30 分鐘檢查目標價（盤中 9:00-13:30 台灣時間）
cron.schedule('*/30 1-5 * * 1-5', checkPriceAlerts);

// ── API 端點 ──────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status:'ok', message:'Taiwan Stock Proxy v3', version:'3.0' });
});

// 儲存通知設定
app.post('/api/notify/settings', (req, res) => {
  const { userId, email, watchlist, alerts, dailySummary } = req.body;
  if (!userId || !email) return res.status(400).json({ error:'需要 userId 和 email' });
  notifySettings[userId] = { email, watchlist:watchlist||[], alerts:alerts||[], dailySummary:!!dailySummary };
  res.json({ ok:true });
});

// 取得通知設定
app.get('/api/notify/settings/:userId', (req, res) => {
  const s = notifySettings[req.params.userId];
  res.json(s || { email:'', watchlist:[], alerts:[], dailySummary:false });
});

// 手動觸發測試信
app.post('/api/notify/test', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error:'需要 email' });
  try {
    await sendMail(email, '台股分析儀 — 測試信件',
      '<div style="font-family:sans-serif;padding:20px"><h2 style="color:#16a34a">測試成功！</h2><p>台股分析儀的 Email 通知功能已正常設定。</p></div>');
    res.json({ ok:true, message:'測試信已發送' });
  } catch(e) {
    res.status(500).json({ error:e.message });
  }
});

// 手動觸發收盤摘要
app.post('/api/notify/send-summary', async (req, res) => {
  try {
    await sendDailySummary();
    res.json({ ok:true });
  } catch(e) {
    res.status(500).json({ error:e.message });
  }
});

// 即時股價
app.get('/api/price/:code', async (req, res) => {
  try {
    const p = await getLatestPrice(req.params.code);
    if (!p) return res.status(404).json({ error:'找不到此股票代號' });
    res.json(p);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// K 線
app.get('/api/candles/:code', async (req, res) => {
  try {
    const data = await fm({ dataset:'TaiwanStockPrice', data_id:req.params.code, start_date:daysAgo(90) });
    if (!data.length) return res.status(404).json({ error:'找不到此股票代號' });
    res.json({ code:req.params.code, candles:data.slice(-60).map(d=>({
      date:d.date, open:d.open, high:d.max, low:d.min, close:d.close, volume:d.Trading_Volume
    }))});
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// 基本面
app.get('/api/fundamental/:code', async (req, res) => {
  try {
    const code = req.params.code;
    const [peR,divR,revR,finR] = await Promise.allSettled([
      fm({ dataset:'TaiwanStockPER', data_id:code, start_date:daysAgo(730) }),
      fm({ dataset:'TaiwanStockDividendResult', data_id:code, start_date:daysAgo(730) }),
      fm({ dataset:'TaiwanStockMonthRevenue', data_id:code, start_date:daysAgo(400) }),
      fm({ dataset:'TaiwanStockFinancialStatements', data_id:code, start_date:daysAgo(730) }),
    ]);
    let pe=null,pb=null,divYield=null,revenueGrowth=null,roe=null,eps=null,grossMargin=null,debtRatio=null;
    if(peR.status==='fulfilled'&&peR.value.length){const l=peR.value[peR.value.length-1];pe=l.PER?+l.PER.toFixed(1):null;pb=l.PBR?+l.PBR.toFixed(1):null;}
    if(divR.status==='fulfilled'&&divR.value.length){const l=divR.value[divR.value.length-1];divYield=l.yield?+l.yield.toFixed(2):null;}
    if(revR.status==='fulfilled'&&revR.value.length){const l=revR.value[revR.value.length-1];revenueGrowth=l.year_on_year?+l.year_on_year.toFixed(1):null;}
    if(finR.status==='fulfilled'&&finR.value.length){
      const items=finR.value;
      const roeI=items.filter(x=>x.type==='ROE').pop();
      const epsI=items.filter(x=>x.type==='EPS').pop();
      const gmI=items.filter(x=>x.type==='GrossMargin'||x.type==='毛利率').pop();
      const drI=items.filter(x=>x.type==='DebtRatio'||x.type==='負債比率').pop();
      if(roeI)roe=+parseFloat(roeI.value).toFixed(1);
      if(epsI)eps=+parseFloat(epsI.value).toFixed(2);
      if(gmI)grossMargin=+parseFloat(gmI.value).toFixed(1);
      if(drI)debtRatio=+parseFloat(drI.value).toFixed(1);
    }
    const pd=await fm({dataset:'TaiwanStockPrice',data_id:code,start_date:daysAgo(365)}).catch(()=>[]);
    const week52High=pd.length?Math.max(...pd.map(d=>d.max)):null;
    const week52Low=pd.length?Math.min(...pd.map(d=>d.min)):null;
    res.json({code,pe,pb,roe,eps,divYield,revenueGrowth,grossMargin,debtRatio,week52High,week52Low});
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// 搜尋
app.get('/api/search/:keyword', async (req, res) => {
  try {
    const data = await fm({ dataset:'TaiwanStockInfo' });
    const results = data.filter(s=>s.stock_id.includes(req.params.keyword)||(s.stock_name&&s.stock_name.includes(req.params.keyword))).slice(0,20).map(s=>({code:s.stock_id,name:s.stock_name,type:s.type}));
    res.json({ results });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// 市場
app.get('/api/market', async (req, res) => {
  try {
    const data = await fm({ dataset:'TaiwanStockPrice', data_id:'TAIEX', start_date:daysAgo(90) }).catch(()=>[]);
    if(!data.length) return res.json({index:null,trend:'unknown'});
    const closes=data.map(d=>d.close);
    const last=closes[closes.length-1];
    const avg20=closes.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,closes.length);
    const avg60=closes.reduce((a,b)=>a+b,0)/closes.length;
    const change30=closes.length>=30?((last-closes[closes.length-30])/closes[closes.length-30]*100):0;
    let trend='sideways';
    if(last>avg20&&avg20>avg60&&change30>5)trend='bull';
    else if(last<avg20&&avg20<avg60&&change30<-5)trend='bear';
    else if(Math.abs(change30)>8)trend='volatile';
    const returns=closes.slice(-20).map((v,i,a)=>i>0?(v-a[i-1])/a[i-1]*100:0).slice(1);
    const mean=returns.reduce((a,b)=>a+b,0)/returns.length;
    const volatility=+Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/returns.length).toFixed(2);
    res.json({index:last,trend,change30:+change30.toFixed(1),volatility,avg20:+avg20.toFixed(0),avg60:+avg60.toFixed(0)});
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// 批次價格
app.post('/api/prices', async (req, res) => {
  try {
    const { codes } = req.body;
    if(!codes||!Array.isArray(codes)) return res.status(400).json({error:'需要 codes 陣列'});
    const results = await Promise.allSettled(codes.slice(0,10).map(getLatestPrice));
    const prices = {};
    results.forEach((r,i)=>{if(r.status==='fulfilled'&&r.value)prices[codes[i]]=r.value;});
    res.json({ prices });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.listen(PORT, () => console.log(`Stock proxy v3 running on port ${PORT}`));
