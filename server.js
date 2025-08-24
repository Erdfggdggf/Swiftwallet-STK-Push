const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(cors({
  origin: 'https://shiny-centaur-0fddda.netlify.app'   // adjust if frontend changes
}));

// -------- Firebase Init --------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT env variable");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const { FieldValue } = admin.firestore;

// -------- Helpers --------
function formatPhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length === 9 && digits.startsWith('7')) return '254' + digits;
  if (digits.length === 10 && digits.startsWith('07')) return '254' + digits.substring(1);
  if (digits.length === 12 && digits.startsWith('254')) return digits;
  return null;
}

// -------- STK Push Endpoint --------
app.post('/pay', async (req, res) => {
  try {
    const { phone, amount } = req.body;
    const formattedPhone = formatPhone(phone);

    if (!formattedPhone) {
      return res.status(400).json({ success: false, error: 'Invalid phone format' });
    }
    if (!amount || amount < 1) {
      return res.status(400).json({ success: false, error: 'Amount must be >= 1' });
    }

    const external_reference = 'ORDER-' + Date.now();

    // Save pending transaction
    await db.collection("transactions").doc(external_reference).set({
      phone: formattedPhone,
      amount: Math.round(amount),
      status: "PENDING",
      createdAt: FieldValue.serverTimestamp()
    });

    const payload = {
      amount: Math.round(amount),
      phone_number: formattedPhone,
      external_reference,
      customer_name: 'Customer',
      callback_url: `${process.env.BASE_URL}/callback?secret=${process.env.CALLBACK_SECRET}`,
      channel_id: "000041"
    };

    const url = "https://swiftwallet.co.ke/pay-app-v2/payments.php";
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer fb53284f56ed14a6ea3ca908c70763b5d00d03e769576611e5f337709d4c7f5a`,
        'Content-Type': 'application/json'
      }
    });

    console.log("SwiftWallet response:", resp.data);

    if (resp.data?.success) {
      res.json({ success: true, message: "STK push sent, check your phone" });
    } else {
      res.status(400).json({ success: false, error: resp.data?.error || "Payment initiation failed" });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// -------- Callback Endpoint --------
app.post('/callback', async (req, res) => {
  try {
    if (process.env.CALLBACK_SECRET && req.query.secret !== process.env.CALLBACK_SECRET) {
      console.warn("Unauthorized callback attempt");
      return res.status(401).json({ ResultCode: 1, ResultDesc: "Unauthorized" });
    }

    const data = req.body;
    console.log("Callback received:", data);

    const phone = formatPhone(data.phone_number);
    const amount = Number(data.amount);
    const reference = data.external_reference;
    const success = data.success;

    if (success && phone && reference) {
      // Update transaction
      const txnRef = db.collection("transactions").doc(reference);
      await txnRef.set({
        status: "SUCCESS",
        callback: data,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      // Update user balance
      const userRef = db.collection("users").doc(phone);
      await db.runTransaction(async (t) => {
        const doc = await t.get(userRef);
        let newBalance = amount;
        if (doc.exists) {
          newBalance += doc.data().balance || 0;
        }
        t.set(userRef, { phone, balance: newBalance, updatedAt: FieldValue.serverTimestamp() });
      });

      console.log(`✅ Balance updated for ${phone}`);
    }

    res.json({ ResultCode: 0, ResultDesc: "Success" });

  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).json({ ResultCode: 1, ResultDesc: "Failed" });
  }
});

// -------- Get Balance Endpoint --------
app.get('/balance/:phone', async (req, res) => {
  const phone = formatPhone(req.params.phone);
  if (!phone) return res.status(400).json({ success: false, error: "Invalid phone" });

  const doc = await db.collection("users").doc(phone).get();
  if (!doc.exists) return res.json({ phone, balance: 0 });

  res.json({ phone, balance: doc.data().balance });
});

// -------- Start Server --------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
