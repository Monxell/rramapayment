# Payment Gateway API Documentation

Base URL: `https://payment.warung-api.my.id`

---

## Endpoints

### 1. GET /api/products
Mendapatkan daftar produk DANA.

**Response:**
```json
{
  "success": true,
  "data": {
    "products": {
      "promo": [
        {"id": 642, "code": "DANA10K", "name": "10k", "price": 10180, "promo": true}
      ],
      "non_promo": [
        {"id": 12423, "code": "DANABF10", "name": "10K", "price": 10350, "promo": false}
      ]
    }
  }
}
```

---

### 2. POST /api/create-transaction
Membuat transaksi top-up DANA.

**Request Body:**
```json
{
  "user_id": "08983628647",
  "product_detail_id": 642,
  "price": 10180,
  "payment_method": "qris",
  "customer_id": "",
  "voucher_code": "",
  "voucher_amount": 0,
  "discounted_price": 0
}
```

**Required Fields:**
- `user_id` — Nomor HP tujuan top-up
- `product_detail_id` — ID produk dari `/api/products`
- `price` — Harga produk sesuai dari `/api/products`

**Response:**
```json
{
  "success": true,
  "data": {
    "transaction_id": "pay_VzqllyJ9Ip5210",
    "order_id": "3815151785",
    "qr_code_url": "https://topupservice.belanjapasti.com/v2/payments/qr/pay_VzqllyJ9Ip5210",
    "transaction_at": "2026-09-09 05:42:11"
  }
}
```

---

### 3. POST /api/check-transaction
Mengecek status pembayaran transaksi.

**Request Body:**
```json
{
  "transaction_id": "pay_VzqllyJ9Ip5210"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "SUCCESS",
    "paid_at": "2026-09-09 06:57:21"
  }
}
```

**Possible Status Values:**
- `PENDING` — Belum dibayar
- `SUCCESS` — Pembayaran berhasil
- `FAILED` — Pembayaran gagal

---

## Error Handling

Semua endpoint return format error yang sama:

```json
{
  "success": false,
  "message": "Error description",
  "error": "Detail error"
}
```

HTTP Status Codes:
- `400` — Bad Request (missing fields)
- `500` — Upstream error dari provider

---

## Contoh Implementasi Bot WhatsApp

```javascript
const axios = require("axios");

const API_BASE_URL = "https://payment.warung-api.my.id/api";

async function createOrder(nomorHp, kodeProduk) {
  // 1. Ambil daftar produk
  const { data: productResponse } = await axios.get(`${API_BASE_URL}/products`);
  const allProducts = [
    ...productResponse.data.products.promo,
    ...productResponse.data.products.non_promo
  ];
  
  const produk = allProducts.find(p => p.code === kodeProduk);
  if (!produk) throw new Error("Produk tidak ditemukan");

  // 2. Buat transaksi
  const { data: trxResponse } = await axios.post(`${API_BASE_URL}/create-transaction`, {
    user_id: nomorHp,
    product_detail_id: produk.id,
    price: produk.price,
    payment_method: "qris"
  });

  if (!trxResponse.success) throw new Error("Gagal generate QRIS");

  const { transaction_id, order_id, qr_code_url } = trxResponse.data;

  // 3. Kirim QRIS ke user
  await sendImageToUser(qr_code_url, order_id, produk, nomorHp);

  // 4. Polling status setiap 10 detik, max 5 menit
  let maxCheck = 30;
  let isPaid = false;

  while (maxCheck > 0) {
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    const { data: checkResponse } = await axios.post(`${API_BASE_URL}/check-transaction`, {
      transaction_id
    });

    if (checkResponse.success && checkResponse.data.status === "SUCCESS") {
      isPaid = true;
      break;
    }
    
    maxCheck--;
  }

  if (isPaid) {
    await sendSuccessNotification(order_id, produk, nomorHp);
  } else {
    await sendTimeoutNotification(order_id);
  }
}
```

---

## Catatan Penting

1. **Polling**: Status pembayaran perlu di-poll berkala. Rekomendasi: setiap 10-15 detik, max 5 menit.
2. **Transaction ID**: Simpan `transaction_id` dari response create-transaction untuk pengecekan status.
3. **Price**: Gunakan harga dari `/api/products` agar sesuai dengan harga terbaru.
4. **Payment Method**: Default `qris`. Lainnya bisa ditambahkan jika dibutuhkan.
5. **Anti-gagal**: API ini tidak menjamin 100% sukses. Bergantung pada kondisi provider `topupservice.belanjapasti.com`.
