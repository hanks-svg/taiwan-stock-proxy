const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const FINMIND_TOKEN = process.env.FINMIND_TOKEN;
const BASE = 'https://api.finmindtrade.com/api/v4/data';

app.use(cors());
app.use(express.json());

// 健康檢查
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Taiwan Stock Proxy is running', version: '2.0' });
});

// 工具函式
async function fm(params) {
  const url = new URL(BASE);
  url.searchParams.set('token', FINMIND_TOKEN);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString());
  const d = await r.json();
  if (d.status !== 200) throw new Error(d.msg || 'FinMind error');
  return d.data;
}

function daysAgo(n) {
  return new Date(Date.now() - n*86400000).toISOString().slice(0,10);
}

// ── 即時股價 ──────────────────────────────────────
app.get('/api/price/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const data = await fm({ dataset:'TaiwanStockPrice', data_id:code, start_date:daysAgo(14) });
    if (!data.length) return res.status(404).json({ error:'找不到此股票代號' });
    const last = data[data.length-1], prev = data.length>1 ? data[data.length-2] : last;
    const change = +(last.close - prev.close).toFixed(2);
    res.json({ code, date:last.date, price:last.close, open:last.open,
      high:last.max, low:last.min, volume:last.Trading_Volume,
      change, changePct:+((change/prev.close)*100).toFixed(2) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── K 線（近 60 日）────────────────────────────────
app.get('/api/candles/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const data = await fm({ dataset:'TaiwanStockPrice', data_id:code, start_date:daysAgo(90) });
    if (!data.length) return res.status(404).json({ error:'找不到此股票代號' });
    res.json({ code, candles: data.slice(-60).map(d => ({
      date:d.date, open:d.open, high:d.max, low:d.min, close:d.close, volume:d.Trading_Volume
    }))});
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── 完整基本面（PE/PB/ROE/EPS/殖利率/毛利率/營收成長）──
app.get('/api/fundamental/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const start2y = daysAgo(730);
    const start1y = daysAgo(400);

    const [peR, divR, revR, finR] = await Promise.allSettled([
      fm({ dataset:'TaiwanStockPER',           data_id:code, start_date:start2y }),
      fm({ dataset:'TaiwanStockDividendResult', data_id:code, start_date:start2y }),
      fm({ dataset:'TaiwanStockMonthRevenue',   data_id:code, start_date:start1y }),
      fm({ dataset:'TaiwanStockFinancialStatements', data_id:code, start_date:start2y }),
    ]);

    let pe=null, pb=null;
    if (peR.status==='fulfilled' && peR.value.length) {
      const l = peR.value[peR.value.length-1];
      pe = l.PER ? +l.PER.toFixed(1) : null;
      pb = l.PBR ? +l.PBR.toFixed(1) : null;
    }

    let divYield=null;
    if (divR.status==='fulfilled' && divR.value.length) {
      const l = divR.value[divR.value.length-1];
      divYield = l.yield ? +l.yield.toFixed(2) : null;
    }

    let revenueGrowth=null;
    if (revR.status==='fulfilled' && revR.value.length) {
      const l = revR.value[revR.value.length-1];
      revenueGrowth = l.year_on_year ? +l.year_on_year.toFixed(1) : null;
    }

    let roe=null, eps=null, grossMargin=null, debtRatio=null;
    if (finR.status==='fulfilled' && finR.value.length) {
      // 找最新一季
      const items = finR.value;
      const roeItem = items.filter(x=>x.type==='ROE').pop();
      const epsItem = items.filter(x=>x.type==='EPS').pop();
      const gmItem  = items.filter(x=>x.type==='GrossMargin' || x.type==='毛利率').pop();
      const drItem  = items.filter(x=>x.type==='DebtRatio'   || x.type==='負債比率').pop();
      if (roeItem) roe         = +parseFloat(roeItem.value).toFixed(1);
      if (epsItem) eps         = +parseFloat(epsItem.value).toFixed(2);
      if (gmItem)  grossMargin = +parseFloat(gmItem.value).toFixed(1);
      if (drItem)  debtRatio   = +parseFloat(drItem.value).toFixed(1);
    }

    // 52 週高低
    const priceData = await fm({ dataset:'TaiwanStockPrice', data_id:code, start_date:daysAgo(365) }).catch(()=>[]);
    const week52High = priceData.length ? Math.max(...priceData.map(d=>d.max)) : null;
    const week52Low  = priceData.length ? Math.min(...priceData.map(d=>d.min)) : null;

    res.json({ code, pe, pb, roe, eps, divYield, revenueGrowth, grossMargin, debtRatio, week52High, week52Low });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── 搜尋股票 ──────────────────────────────────────
app.get('/api/search/:keyword', async (req, res) => {
  try {
    const { keyword } = req.params;
    const data = await fm({ dataset:'TaiwanStockInfo' });
    const results = data
      .filter(s => s.stock_id.includes(keyword) || (s.stock_name && s.stock_name.includes(keyword)))
      .slice(0,20)
      .map(s => ({ code:s.stock_id, name:s.stock_name, type:s.type }));
    res.json({ results });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── 市場整體資訊（大盤指數）──────────────────────
app.get('/api/market', async (req, res) => {
  try {
    const data = await fm({ dataset:'TaiwanStockPrice', data_id:'TAIEX', start_date:daysAgo(90) }).catch(()=>[]);
    if (!data.length) return res.json({ index:null, trend:'unknown' });
    const closes = data.map(d=>d.close);
    const last = closes[closes.length-1];
    const avg20 = closes.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,closes.length);
    const avg60 = closes.reduce((a,b)=>a+b,0)/closes.length;
    const change30 = closes.length>=30 ? ((last-closes[closes.length-30])/closes[closes.length-30]*100) : 0;

    // 判斷市場狀態
    let trend = 'sideways';
    if (last > avg20 && avg20 > avg60 && change30 > 5) trend = 'bull';
    else if (last < avg20 && avg20 < avg60 && change30 < -5) trend = 'bear';
    else if (Math.abs(change30) > 8) trend = 'volatile';

    const volatility = (()=>{
      const returns = closes.slice(-20).map((v,i,a)=>i>0?(v-a[i-1])/a[i-1]*100:0).slice(1);
      const mean = returns.reduce((a,b)=>a+b,0)/returns.length;
      const variance = returns.reduce((a,b)=>a+(b-mean)**2,0)/returns.length;
      return +Math.sqrt(variance).toFixed(2);
    })();

    res.json({ index:last, trend, change30:+change30.toFixed(1), volatility, avg20:+avg20.toFixed(0), avg60:+avg60.toFixed(0) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── 批次查詢多檔股票價格 ─────────────────────────
app.post('/api/prices', async (req, res) => {
  try {
    const { codes } = req.body;
    if (!codes || !Array.isArray(codes)) return res.status(400).json({ error:'需要 codes 陣列' });
    const results = await Promise.allSettled(
      codes.slice(0,10).map(code =>
        fm({ dataset:'TaiwanStockPrice', data_id:code, start_date:daysAgo(10) })
          .then(data => {
            if (!data.length) return null;
            const last=data[data.length-1], prev=data.length>1?data[data.length-2]:last;
            const change = +(last.close-prev.close).toFixed(2);
            return { code, price:last.close, change, changePct:+((change/prev.close)*100).toFixed(2) };
          })
      )
    );
    const prices = {};
    results.forEach((r,i) => { if(r.status==='fulfilled'&&r.value) prices[codes[i]]=r.value; });
    res.json({ prices });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.listen(PORT, () => console.log(`Stock proxy v2 running on port ${PORT}`));
