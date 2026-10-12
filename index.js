const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;

// Load products
const productsDb = JSON.parse(fs.readFileSync('./products.json', 'utf-8'));

const HEADERS = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Origin": "https://topup.ebelanja.id",
    "Referer": "https://topup.ebelanja.id/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) rv:154.0) Gecko/20100101 Firefox/154.0"
};

app.get('/api/products', (req, res) => {
    res.json({
        success: true,
        data: productsDb
    });
});

app.post('/api/create-transaction', async (req, res) => {
    try {
        const { user_id, product_detail_id, price, customer_id = "", payment_method = "qris" } = req.body;

        if (!user_id || !product_detail_id || !price) {
            return res.status(400).json({ success: false, message: "user_id, product_detail_id, and price are required." });
        }

        const payload = {
            user_id,
            product_detail_id,
            payment_method,
            customer_id,
            voucher_code: "",
            voucher_amount: 0,
            discounted_price: 0,
            price
        };

        const response = await axios.post("https://topupservice.belanjapasti.com/v2/transactions", payload, { headers: HEADERS });
        const resData = response.data.data;

        res.json({
            success: true,
            data: resData
        });
    } catch (error) {
        console.error("Error creating transaction:", error?.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: "Failed to create transaction",
            error: error?.response?.data || error.message
        });
    }
});

app.post('/api/check-transaction', async (req, res) => {
    try {
        const { transaction_id } = req.body;

        if (!transaction_id) {
            return res.status(400).json({ success: false, message: "transaction_id is required." });
        }

        const payload = { transaction_id };

        const response = await axios.post("https://topupservice.belanjapasti.com/v2/transactions/check", payload, { headers: HEADERS });

        res.json({
            success: true,
            data: response.data.data
        });
    } catch (error) {
        console.error("Error checking transaction:", error?.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: "Failed to check transaction",
            error: error?.response?.data || error.message
        });
    }
});

app.get('/docs', (req, res) => {
  res.sendFile(__dirname + '/docs.html');
});

app.listen(PORT, () => {
    console.log(`Payment Gateway API is running on http://localhost:${PORT}`);
});
