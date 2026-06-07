const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const FINMIND_TOKEN = process.env.FINMIND_TOKEN;
const FINMIND_BASE = 'https://api.finmindtrade.com/api/v4/data';

app.use(cors());
app.use(express.json());

// ── 健康檢查 ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Taiwan Stock Proxy is running' });
});

// ── 工具：呼叫 FinMind ────────────────────────────────
async function finmind(params) {
  const url = new URL(FINMIND_BASE);
  url.searchParams.set('token', FINMIND_TOKEN);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.status !== 200) throw new Error(data.msg || 'FinMind error');
  return data.data;
}

// ── 取得今日收盤價與基本資訊 ─────────────────────────
// GET /api/price/:code
app.get('/api/price/:code', async (req, res) => {
  try {
    const { code } = req.params;
    // 近 10 天資料，取最後一筆
    const today = new Date();
    const start = new Date(today - 14 * 86400000).toISOString().slice(0, 10);
    const data = await finmind({
      dataset: 'TaiwanStockPrice',
      data_id: code,
      start_date: start,
    });
    if (!data.length) return res.status(404).json({ error: '找不到此股票代號' });
    const last = data[data.length - 1];
    const prev = data.length > 1 ? data[data.length - 2] : last;
    const change = +(last.close - prev.close).toFixed(2);
    const changePct = +((change / prev.close) * 100).toFixed(2);
    res.json({
      code,
      date: last.date,
      price: last.close,
      open: last.open,
      high: last.max,
      low: last.min,
      volume: last.Trading_Volume,
      change,
      changePct,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── K線資料（近 60 日）────────────────────────────────
// GET /api/candles/:code
app.get('/api/candles/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const today = new Date();
    const start = new Date(today - 90 * 86400000).toISOString().slice(0, 10);
    const data = await finmind({
      dataset: 'TaiwanStockPrice',
      data_id: code,
      start_date: start,
    });
    if (!data.length) return res.status(404).json({ error: '找不到此股票代號' });
    const candles = data.slice(-60).map(d => ({
      date: d.date,
      open: d.open,
      high: d.max,
      low: d.min,
      close: d.close,
      volume: d.Trading_Volume,
    }));
    res.json({ code, candles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 基本面資料 ───────────────────────────────────────
// GET /api/fundamental/:code
app.get('/api/fundamental/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const today = new Date();
    const start = new Date(today - 365 * 2 * 86400000).toISOString().slice(0, 10);

    // 同時撈多個資料集
    const [peData, dividendData, revenueData] = await Promise.allSettled([
      finmind({ dataset: 'TaiwanStockPER', data_id: code, start_date: start }),
      finmind({ dataset: 'TaiwanStockDividendResult', data_id: code, start_date: start }),
      finmind({ dataset: 'TaiwanStockMonthRevenue', data_id: code, start_date: start }),
    ]);

    // PE / PB
    let pe = null, pb = null;
    if (peData.status === 'fulfilled' && peData.value.length) {
      const last = peData.value[peData.value.length - 1];
      pe = last.PER ? +last.PER.toFixed(1) : null;
      pb = last.PBR ? +last.PBR.toFixed(1) : null;
    }

    // 殖利率
    let divYield = null;
    if (dividendData.status === 'fulfilled' && dividendData.value.length) {
      const last = dividendData.value[dividendData.value.length - 1];
      divYield = last.yield ? +last.yield.toFixed(2) : null;
    }

    // 近月營收年增率
    let revenueGrowth = null;
    if (revenueData.status === 'fulfilled' && revenueData.value.length) {
      const rev = revenueData.value;
      if (rev.length >= 2) {
        const last = rev[rev.length - 1];
        revenueGrowth = last.year_on_year ? +last.year_on_year.toFixed(1) : null;
      }
    }

    res.json({ code, pe, pb, divYield, revenueGrowth });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 搜尋股票名稱 ─────────────────────────────────────
// GET /api/search/:keyword
app.get('/api/search/:keyword', async (req, res) => {
  try {
    const { keyword } = req.params;
    const data = await finmind({ dataset: 'TaiwanStockInfo' });
    const keyword_lower = keyword.toLowerCase();
    const results = data
      .filter(s =>
        s.stock_id.includes(keyword) ||
        (s.stock_name && s.stock_name.includes(keyword))
      )
      .slice(0, 20)
      .map(s => ({ code: s.stock_id, name: s.stock_name, type: s.type }));
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 52週高低點 ────────────────────────────────────────
// GET /api/week52/:code
app.get('/api/week52/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const today = new Date();
    const start = new Date(today - 365 * 86400000).toISOString().slice(0, 10);
    const data = await finmind({
      dataset: 'TaiwanStockPrice',
      data_id: code,
      start_date: start,
    });
    if (!data.length) return res.status(404).json({ error: '無資料' });
    const high = Math.max(...data.map(d => d.max));
    const low = Math.min(...data.map(d => d.min));
    res.json({ code, week52High: high, week52Low: low });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Stock proxy running on port ${PORT}`);
});
