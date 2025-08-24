const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(cors({
  origin: 'https://astonishing-cassata-3e8929.netlify.app'   // keep your frontend domain
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
      channel_id: process.env.CHANNEL_ID || "000041"
    };

    const url = "https://swiftwallet.co.ke/pay-app-v2/payments.php";
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${process.env.SWIFTWALLET_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    console.log("📤 SwiftWallet response:", resp.data);

    if (resp.data?.success) {
      await db.collection("transactions").doc(external_reference).set({
        phone: formattedPhone,
        status: "INITIATED",
        swiftwallet: resp.data,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      res.json({ success: true, message: "STK push sent, check your phone" });
    } else {
      await db.collection("transactions").doc(external_reference).set({
        phone: formattedPhone,
        status: "FAILED",
        error: resp.data?.error || "Payment initiation failed",
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      res.status(400).json({ success: false, error: resp.data?.error || "Payment initiation failed" });
    }

  } catch (err) {
    console.error("🚨 /pay error:", err);
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
    console.log("📥 Callback received:", data);

    const phone = formatPhone(data?.result?.Phone || data.phone_number);
    const amount = Number(data?.result?.Amount || data.amount);
    const reference = data.external_reference;

    // ✅ Flexible success check
    const status = data?.status || data?.result?.status;
    const isSuccess = (data.success === true) || (status && status.toLowerCase() === "completed");

    if (isSuccess && phone && reference) {
      // Update transaction
      const txnRef = db.collection("transactions").doc(reference);
      await txnRef.set({
        phone,
        status: "SUCCESS",
        callback: data,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      // Update user balance atomically
      const userRef = db.collection("users").doc(phone);
      await db.runTransaction(async (t) => {
        const doc = await t.get(userRef);
        let newBalance = amount;
        if (doc.exists) {
          newBalance += doc.data().balance || 0;
        }
        t.set(userRef, { 
          phone, 
          balance: newBalance, 
          updatedAt: FieldValue.serverTimestamp() 
        });
      });

      console.log(`✅ Balance updated for ${phone} +${amount}`);
    } else {
      console.log("⚠️ Callback not successful or missing data:", data);
    }

    res.json({ ResultCode: 0, ResultDesc: "Success" });

  } catch (err) {
    console.error("🚨 Callback error:", err);
    res.status(500).json({ ResultCode: 1, ResultDesc: "Failed" });
  }
});

// -------- Get Balance + Transactions --------
app.get('/balance/:phone', async (req, res) => {
  try {
    const phone = formatPhone(req.params.phone);
    if (!phone) return res.status(400).json({ success: false, error: "Invalid phone" });

    const userDoc = await db.collection("users").doc(phone).get();
    let balance = userDoc.exists ? (userDoc.data().balance || 0) : 0;

    // ✅ Safety fallback: if balance is 0, recalc from transactions
    if (balance === 0) {
      const txnsSnap = await db.collection("transactions")
        .where("phone", "==", phone)
        .where("status", "==", "SUCCESS")
        .get();

      balance = txnsSnap.docs.reduce((sum, doc) => sum + (doc.data().amount || 0), 0);
    }

    let transactions = [];
    try {
      const txnsSnap = await db.collection("transactions")
        .where("phone", "==", phone)
        .orderBy("createdAt", "desc")
        .limit(5)
        .get();

      transactions = txnsSnap.docs.map(doc => {
        const d = doc.data();
        return {
          id: doc.id,
          amount: d.amount,
          status: d.status,
          createdAt: d.createdAt ? d.createdAt.toDate() : null
        };
      });
    } catch (indexErr) {
      console.warn("⚠️ Firestore index not ready yet:", indexErr.message);
      transactions = [];
    }

    res.json({ 
      success: true, 
      phone, 
      balance, 
      transactions 
    });

  } catch (err) {
    console.error("🚨 /balance error:", err);
    res.status(500).json({ success: false, error: "Server error while fetching balance" });
  }
});

// -------- Start Server --------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
