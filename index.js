const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '100kb' }));

const PORT = process.env.PORT || 4000;
const PRODUCTS_PATH = path.join(__dirname, 'products.json');
const UPSTREAM_BASE_URL = 'https://topupservice.belanjapasti.com/v2';

let productsDb;
try {
  productsDb = JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
} catch (error) {
  console.error('Unable to load products.json:', error.message);
  // The app can still start so Vercel logs show a useful error instead of a module crash.
  productsDb = { products: { promo: [], non_promo: [] } };
}

const HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Origin: 'https://topup.ebelanja.id',
  Referer: 'https://topup.ebelanja.id/',
  'User-Agent': 'Mozilla/5.0'
};

const upstream = axios.create({
  baseURL: UPSTREAM_BASE_URL,
  headers: HEADERS,
  timeout: 15000
});

function allProducts() {
  const groups = productsDb && productsDb.products;
  if (!groups) return [];
  return [
    ...(Array.isArray(groups.promo) ? groups.promo : []),
    ...(Array.isArray(groups.non_promo) ? groups.non_promo : [])
  ];
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'index.html'), error => {
    if (error && !res.headersSent) res.status(404).send('Website file not found.');
  });
});

app.get('/api', (req, res) => {
  res.json({
    success: true,
    message: 'Payment Gateway API is running',
    endpoints: ['/api/products', '/api/catalog', '/api/create-transaction', '/api/check-transaction', '/api/qr/:id', '/api/qris', '/docs']
  });
});

app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok' });
});

const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => now - t < windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ success: false, message: 'Terlalu banyak permintaan. Coba lagi beberapa menit lagi.' });
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear();
    next();
  };
}

function nominalOf(product) {
  const n = parseInt(String(product.name).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n * 1000 : null;
}

// One entry per nominal (cheapest product wins), with kode_unik = price - nominal.
app.get('/api/catalog', (req, res) => {
  const best = new Map();
  for (const p of allProducts()) {
    const nominal = nominalOf(p);
    if (!nominal || p.price < nominal) continue;
    const cur = best.get(nominal);
    if (!cur || p.price < cur.price) {
      best.set(nominal, { id: p.id, nominal, price: p.price, kode_unik: p.price - nominal });
    }
  }
  res.json({ success: true, data: [...best.values()].sort((a, b) => a.nominal - b.nominal) });
});

app.get('/api/qr/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^pay_[A-Za-z0-9_-]{4,64}$/.test(id)) {
    return res.status(400).json({ success: false, message: 'Invalid transaction id.' });
  }
  try {
    const r = await upstream.get('/payments/qr/' + encodeURIComponent(id), {
      responseType: 'arraybuffer',
      headers: { Accept: 'image/*,*/*' }
    });
    res.set('Content-Type', r.headers['content-type'] || 'image/png');
    res.set('Cache-Control', 'private, max-age=300');
    return res.send(Buffer.from(r.data));
  } catch (error) {
    console.error('Error fetching QR:', error.message);
    return res.status(502).json({ success: false, message: 'Failed to load QR image.' });
  }
});

// ---------- QRIS merchant sendiri (static -> dynamic) ----------
// Isi env QRIS_STATIC di Vercel dengan teks QRIS statis merchant kamu (hasil scan stiker/QR QRIS).
const QRIS_STATIC = (process.env.QRIS_STATIC || '').trim();
const ADMIN_FEE = Math.max(0, parseInt(process.env.ADMIN_FEE || '0', 10) || 0);
const QRIS_MIN = 1000, QRIS_MAX = 10000000;

function crc16(str) {
  let c = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    c ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1);
    c &= 0xFFFF;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}
function tlv(str) {
  const out = {};
  let i = 0;
  while (i + 4 <= str.length) {
    const len = parseInt(str.substr(i + 2, 2), 10);
    if (!(len >= 0)) break;
    out[str.substr(i, 2)] = str.substr(i + 4, len);
    i += 4 + len;
  }
  return out;
}
const qrisOk = /^000201/.test(QRIS_STATIC) && /6304[0-9A-Fa-f]{4}$/.test(QRIS_STATIC) &&
  crc16(QRIS_STATIC.slice(0, -4)) === QRIS_STATIC.slice(-4).toUpperCase() &&
  QRIS_STATIC.includes('5802ID') && !tlv(QRIS_STATIC)['54'];
const merchantName = qrisOk ? (tlv(QRIS_STATIC)['59'] || '') : '';

function qrisDynamic(total) {
  const amt = String(total);
  let s = QRIS_STATIC.slice(0, -4).replace('010211', '010212');
  s = s.replace('5802ID', '54' + String(amt.length).padStart(2, '0') + amt + '5802ID');
  return s + crc16(s);
}

app.get('/api/qris/config', (req, res) => {
  res.json({ success: true, data: { configured: qrisOk, merchant: merchantName, admin_fee: ADMIN_FEE, min: QRIS_MIN, max: QRIS_MAX } });
});

app.post('/api/qris', rateLimit(30, 10 * 60 * 1000), (req, res) => {
  if (!qrisOk) {
    return res.status(503).json({ success: false, message: 'QRIS merchant belum disetel (env QRIS_STATIC kosong/tidak valid).' });
  }
  const body = req.body || {};
  if (body.open === true) {
    return res.json({ success: true, data: { payload: QRIS_STATIC, open: true, merchant: merchantName } });
  }
  const nominal = Number(body.nominal);
  if (!Number.isInteger(nominal) || nominal < QRIS_MIN || nominal > QRIS_MAX) {
    return res.status(400).json({ success: false, message: 'Nominal minimal Rp ' + QRIS_MIN.toLocaleString('id-ID') + '.' });
  }
  const kode = 1 + crypto.randomInt(199); // 1..199
  const total = nominal + ADMIN_FEE + kode;
  res.json({ success: true, data: { payload: qrisDynamic(total), nominal, kode_unik: kode, admin_fee: ADMIN_FEE, total, merchant: merchantName } });
});

app.get('/api/products', (req, res) => {
  res.json({ success: true, data: productsDb });
});

app.post('/api/create-transaction', rateLimit(8, 10 * 60 * 1000), async (req, res) => {
  try {
    const {
      user_id,
      product_detail_id,
      customer_id = '',
      payment_method = 'qris'
    } = req.body || {};

    if (user_id === undefined || user_id === null || String(user_id).trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'user_id is required.'
      });
    }

    const productId = Number(product_detail_id);
    if (!Number.isInteger(productId)) {
      return res.status(400).json({
        success: false,
        message: 'product_detail_id must be a valid product ID.'
      });
    }

    if (String(payment_method).toLowerCase() !== 'qris') {
      return res.status(400).json({
        success: false,
        message: 'Only the QRIS payment method is enabled.'
      });
    }

    // Never trust a price supplied by the browser; resolve the price from the product list.
    const product = allProducts().find(item => Number(item.id) === productId);
    if (!product) {
      return res.status(400).json({
        success: false,
        message: 'Product not found. Refresh the product list and try again.'
      });
    }

    const payload = {
      user_id: String(user_id).trim(),
      product_detail_id: product.id,
      payment_method: 'qris',
      customer_id: String(customer_id || ''),
      voucher_code: '',
      voucher_amount: 0,
      discounted_price: 0,
      price: product.price
    };

    const response = await upstream.post('/transactions', payload);
    const responseData = response.data && response.data.data;

    if (!responseData) {
      console.error('Upstream create transaction response did not contain data.');
      return res.status(502).json({
        success: false,
        message: 'Payment provider returned an unexpected response.'
      });
    }

    const nominal = nominalOf(product);
    return res.json({
      success: true,
      data: responseData,
      amount: { nominal, price: product.price, kode_unik: nominal ? product.price - nominal : null }
    });
  } catch (error) {
    console.error('Error creating transaction:', {
      message: error.message,
      status: error.response && error.response.status
    });

    return res.status(502).json({
      success: false,
      message: 'Failed to create transaction with the payment provider.'
    });
  }
});

app.post('/api/check-transaction', async (req, res) => {
  try {
    const { transaction_id } = req.body || {};

    if (typeof transaction_id !== 'string' || transaction_id.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'transaction_id is required.'
      });
    }

    const response = await upstream.post('/transactions/check', {
      transaction_id: transaction_id.trim()
    });

    if (!response.data || !response.data.data) {
      console.error('Upstream check transaction response did not contain data.');
      return res.status(502).json({
        success: false,
        message: 'Payment provider returned an unexpected response.'
      });
    }

    return res.json({ success: true, data: response.data.data });
  } catch (error) {
    console.error('Error checking transaction:', {
      message: error.message,
      status: error.response && error.response.status
    });

    return res.status(502).json({
      success: false,
      message: 'Failed to check transaction with the payment provider.'
    });
  }
});

app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'docs.html'), error => {
    if (error && !res.headersSent) {
      console.error('Unable to serve docs.html:', error.message);
      res.status(404).send('Documentation file not found.');
    }
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found.'
  });
});

// Vercel's Node function expects the app to be exported, not to open a listening port.
module.exports = app;

// Keep local development working with `npm start`.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Payment Gateway API is running on http://localhost:${PORT}`);
  });
}
