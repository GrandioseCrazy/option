const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = process.env.FUTU_API_BASE || 'http://localhost:8081';

app.use(express.json());
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

function normalizeStooqSymbol(symbol) {
  const cleaned = String(symbol || '').trim().toLowerCase();
  if (!cleaned) return '';
  if (cleaned.endsWith('.us')) return cleaned;
  return `${cleaned}.us`;
}

function parseStooqCsv(csv) {
  if (!csv) return [];
  const lines = csv.trim().split('\n');
  if (lines.length <= 1) return [];

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 5) continue;
    const [dateRaw, openRaw, highRaw, lowRaw, closeRaw, volumeRaw] = parts;
    if (!dateRaw || dateRaw.toLowerCase() === 'date') continue;

    const dateObj = new Date(`${dateRaw}T00:00:00Z`);
    if (Number.isNaN(dateObj.getTime())) continue;

    const close = Number(closeRaw);
    if (Number.isNaN(close)) continue;

    rows.push({
      date: dateRaw,
      open: Number(openRaw),
      high: Number(highRaw),
      low: Number(lowRaw),
      close,
      volume: Number(volumeRaw),
      dateObj
    });
  }

  return rows;
}

app.get('/api/option/chain/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  const targetUrl = `${API_BASE}/market/option/chain/${encodeURIComponent(symbol)}`;

  try {
    const response = await fetch(targetUrl);
    const contentType = response.headers.get('content-type') || 'application/json';
    const body = await response.text();

    res.status(response.status);
    res.set('content-type', contentType);
    res.send(body);
  } catch (error) {
    res.status(502).json({
      error: 'proxy_error',
      message: error.message,
      target: targetUrl
    });
  }
});

app.get('/api/stock/history/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  const stooqSymbol = normalizeStooqSymbol(symbol);
  if (!stooqSymbol) {
    return res.status(400).json({ error: 'invalid_symbol' });
  }

  const targetUrl = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`;
  try {
    const response = await fetch(targetUrl);
    if (!response.ok) {
      throw new Error(`stooq_error:${response.status}`);
    }

    const csv = await response.text();
    const rows = parseStooqCsv(csv).sort((a, b) => a.dateObj - b.dateObj);
    const cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
    const data = rows
      .filter((row) => row.dateObj >= cutoff)
      .map(({ date, open, high, low, close, volume }) => ({
        date,
        open,
        high,
        low,
        close,
        volume
      }));

    return res.json({ symbol: stooqSymbol, data });
  } catch (error) {
    return res.status(502).json({
      error: 'stooq_proxy_error',
      message: error.message,
      target: targetUrl
    });
  }
});

const clientDir = path.join(__dirname, '..', 'client');
app.use(express.static(clientDir));

app.get('*', (req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Option app listening on http://localhost:${PORT}`);
});
