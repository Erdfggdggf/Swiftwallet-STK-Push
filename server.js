// server.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN ||
  "https://comfy-fudge-60a53b.netlify.app";

// ---------- Middleware ----------
app.use(bodyParser.json());
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ---------- Firebase Init ----------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT env variable");
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
const { FieldValue } = admin.firestore;

// ---------- Helpers ----------
function formatPhone(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07"))
    return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}

// Get current balance & last 5 txns from Firestore
async function snapshotFor(phone) {
  // balance
  const userDoc = await db.collection("users").doc(phone).get();
  let balance = userDoc.exists ? Number(userDoc.data().balance || 0) : 0;

  // if invalid, recalc
  if (!userDoc.exists || !Number.isFinite(balance) || balance < 0) {
    const okSnap = await db
      .collection("transactions")
      .where("phone", "==", phone)
      .where("status", "==", "SUCCESS")
      .get();
    balance = okSnap.docs.reduce(
      (sum, d) => sum + (parseFloat(d.data().amount) || 0),
      0
    );
    await db
      .collection("users")
      .doc(phone)
      .set(
        { phone, balance, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
  }

  // last 5 txns
  let transactions = [];
  try {
    const txnsSnap = await db
      .collection("transactions")
      .where("phone", "==", phone)
      .orderBy("createdAt", "desc")
      .limit(5)
      .get();

    transactions = txnsSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        amount: d.amount || 0,
        status: d.status || "PENDING",
        date: d.createdAt
          ? d.createdAt.toDate().toISOString()
          : new Date().toISOString(),
        reference: d.reference || doc.id,
      };
    });
  } catch (e) {
    // index might not exist yet; return empty list for now
    console.warn("⚠️ Firestore index missing for transactions:", e.message);
  }

  return { balance, transactions };
}

// ---------- SSE (multi-client, resilient) ----------
/**
 * Map<string, Set<{res: Response, hb: NodeJS.Timer}>>
 * phone -> set of client connections with heartbeat timers
 */
const sseClients = new Map();

function addSseClient(phone, res) {
  if (!sseClients.has(phone)) sseClients.set(phone, new Set());

  // heartbeat every 25s to keep connection alive on reverse proxies
  const hb = setInterval(() => {
    try {
      res.write(`event: ping\ndata: {"ts":"${new Date().toISOString()}"}\n\n`);
    } catch {
      // if write fails, we'll rely on close cleanup
    }
  }, 25000);

  sseClients.get(phone).add({ res, hb });
}

function removeSseClient(phone, res) {
  const set = sseClients.get(phone);
  if (!set) return;
  for (const entry of set) {
    if (entry.res === res) {
      clearInterval(entry.hb);
      set.delete(entry);
      break;
    }
  }
  if (set.size === 0) sseClients.delete(phone);
}

// Broadcast fresh snapshot + optional status/reference
async function broadcast(phone, opts = {}) {
  const set = sseClients.get(phone);
  if (!set || set.size === 0) return;

  const { balance, transactions } = await snapshotFor(phone);
  const payload = JSON.stringify({
    phone,
    balance,
    transactions,
    status: opts.status || null, // "PENDING" | "SUCCESS" | "FAILED" | null
    reference: opts.reference || null,
    timestamp: new Date().toISOString(),
  });

  for (const { res } of set) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch (e) {
      // connection likely broken; drop it
      removeSseClient(phone, res);
    }
  }
}

app.get("/events/:phone", async (req, res) => {
  const phone = formatPhone(req.params.phone);
  if (!phone) return res.status(400).end();

  // CORS for SSE responses (some hosts strip default CORS headers on streams)
  res.setHeader("Access-Control-Allow-Origin", FRONTEND_ORIGIN);
  res.setHeader("Vary", "Origin");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  addSseClient(phone, res);
  console.log(`📡 SSE connected: ${phone} (clients: ${sseClients.get(phone).size})`);

  // Send an immediate snapshot so UI isn't blank/zero
  try {
    const snap = await snapshotFor(phone);
    res.write(
      `data: ${JSON.stringify({
        phone,
        ...snap,
        status: null,
        reference: null,
        timestamp: new Date().toISOString(),
      })}\n\n`
    );
  } catch (e) {
    console.warn("⚠️ initial snapshot error:", e.message);
  }

  req.on("close", () => {
    removeSseClient(phone, res);
    console.log(
      `❌ SSE closed: ${phone} (left: ${
        sseClients.get(phone)?.size || 0
      })`
    );
  });
});

// ---------- STK Push Endpoint ----------
app.post("/pay", async (req, res) => {
  try {
    const { phone, amount } = req.body;
    const formattedPhone = formatPhone(phone);

    if (!formattedPhone) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid phone format" });
    }
    if (!amount || amount < 1) {
      return res
        .status(400)
        .json({ success: false, message: "Amount must be >= 1" });
    }

    const external_reference = "ORDER-" + Date.now();
    const rounded = Math.round(amount);

    // Save PENDING transaction
    await db
      .collection("transactions")
      .doc(external_reference)
      .set({
        phone: formattedPhone,
        amount: rounded,
        status: "PENDING",
        reference: external_reference,
        createdAt: FieldValue.serverTimestamp(),
      });

    // Notify frontend: waiting for PIN + real snapshot
    await broadcast(formattedPhone, { status: "PENDING", reference: external_reference });

    const payload = {
      amount: rounded,
      phone_number: formattedPhone,
      external_reference,
      customer_name: "Customer",
      callback_url: `${process.env.BASE_URL}/callback?secret=${process.env.CALLBACK_SECRET}`,
      channel_id: process.env.CHANNEL_ID || "000041",
    };

    const url = "https://swiftwallet.co.ke/pay-app-v2/payments.php";
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${process.env.SWIFTWALLET_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    console.log("📩 SwiftWallet response:", resp.data);

    if (resp.data?.success) {
      await db
        .collection("transactions")
        .doc(external_reference)
        .set(
          {
            phone: formattedPhone,
            amount: rounded,
            status: "INITIATED",
            reference: external_reference,
            swiftwallet: resp.data,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

      return res.json({
        success: true,
        message: "STK push sent, check your phone",
        amount: rounded,
        phone: formattedPhone,
        reference: external_reference,
      });
    } else {
      await db
        .collection("transactions")
        .doc(external_reference)
        .set(
          {
            phone: formattedPhone,
            amount: rounded,
            status: "FAILED",
            reference: external_reference,
            error: resp.data?.error || "Payment initiation failed",
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

      await broadcast(formattedPhone, {
        status: "FAILED",
        reference: external_reference,
      });

      return res
        .status(400)
        .json({
          success: false,
          message: resp.data?.error || "Payment initiation failed",
        });
    }
  } catch (err) {
    console.error("🚨 /pay error:", err.response?.data || err.message);
    return res
      .status(500)
      .json({ success: false, message: "Server error during /pay" });
  }
});

// ---------- Callback Endpoint ----------
app.post("/callback", async (req, res) => {
  try {
    if (
      process.env.CALLBACK_SECRET &&
      req.query.secret !== process.env.CALLBACK_SECRET
    ) {
      console.warn("Unauthorized callback attempt");
      return res
        .status(401)
        .json({ ResultCode: 1, ResultDesc: "Unauthorized" });
    }

    const data = req.body;
    console.log("📥 Callback received:", JSON.stringify(data, null, 2));

    // Try several possible fields
    const phone = formatPhone(
      data?.result?.Phone ||
        data?.phone_number ||
        data?.Phone ||
        data?.MSISDN
    );
    const reference =
      data?.external_reference ||
      data?.CheckoutRequestID ||
      data?.reference;

    const rawAmount =
      data?.result?.Amount ||
      data?.amount ||
      data?.Amount ||
      data?.TransAmount ||
      0;
    const amount = parseFloat(rawAmount);

    if (!phone || !reference) {
      console.warn("⚠️ Missing phone or reference in callback", {
        phone,
        reference,
      });
      return res.json({ ResultCode: 0, ResultDesc: "Ignored (missing ids)" });
    }

    if (isNaN(amount) || amount <= 0) {
      console.warn("⚠️ Invalid amount in callback:", rawAmount);
      return res.json({ ResultCode: 0, ResultDesc: "Ignored invalid amount" });
    }

    const status = data?.status || data?.result?.status || data?.ResultCode;
    const resultDesc = data?.ResultDesc || data?.result?.ResultDesc || "";

    const isSuccess =
      data.success === true ||
      status === "0" ||
      status === 0 ||
      (status && String(status).toLowerCase() === "completed") ||
      (resultDesc && resultDesc.toLowerCase().includes("success")) ||
      data?.ResultCode === "0" ||
      data?.ResultCode === 0;

    if (isSuccess) {
      const txnRef = db.collection("transactions").doc(reference);
      await txnRef.set(
        {
          phone,
          amount,
          status: "SUCCESS",
          reference,
          callback: data,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // Update user balance atomically
      const userRef = db.collection("users").doc(phone);
      await db.runTransaction(async (t) => {
        const doc = await t.get(userRef);
        let newBal = amount;
        if (doc.exists) newBal += doc.data().balance || 0;
        t.set(userRef, {
          phone,
          balance: newBal,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });

      console.log(`✅ SUCCESS: ${phone} +${amount} (ref=${reference})`);
      await broadcast(phone, { status: "SUCCESS", reference });
    } else {
      await db
        .collection("transactions")
        .doc(reference)
        .set(
          {
            status: "FAILED",
            callback: data,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

      console.log(`❌ FAILED: ${phone} (ref=${reference})`);
      await broadcast(phone, { status: "FAILED", reference });
    }

    return res.json({ ResultCode: 0, ResultDesc: "OK" });
  } catch (err) {
    console.error("🚨 Callback error:", err);
    return res.status(500).json({ ResultCode: 1, ResultDesc: "Failed" });
  }
});

// ---------- Manual Status Update (testing) ----------
app.post("/update-status/:reference", async (req, res) => {
  try {
    const { reference } = req.params;
    const { status } = req.body;

    const txnRef = db.collection("transactions").doc(reference);
    const txnDoc = await txnRef.get();
    if (!txnDoc.exists)
      return res
        .status(404)
        .json({ success: false, message: "Transaction not found" });

    const txnData = txnDoc.data();
    const up = (status || "").toUpperCase();

    await txnRef.set(
      { status: up, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    if (up === "SUCCESS" && txnData.phone && txnData.amount) {
      const userRef = db.collection("users").doc(txnData.phone);
      await db.runTransaction(async (t) => {
        const doc = await t.get(userRef);
        let newBal = txnData.amount;
        if (doc.exists) newBal += doc.data().balance || 0;
        t.set(userRef, {
          phone: txnData.phone,
          balance: newBal,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      await broadcast(txnData.phone, { status: "SUCCESS", reference });
    } else if (up === "FAILED" && txnData.phone) {
      await broadcast(txnData.phone, { status: "FAILED", reference });
    }

    return res.json({
      success: true,
      message: `Transaction ${reference} updated to ${up}`,
    });
  } catch (err) {
    console.error("🚨 /update-status error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---------- Get Balance + Transactions ----------
app.get("/balance/:phone", async (req, res) => {
  try {
    const phone = formatPhone(req.params.phone);
    if (!phone)
      return res.status(400).json({ success: false, message: "Invalid phone" });

    const snap = await snapshotFor(phone);
    return res.json({ success: true, phone, ...snap });
  } catch (err) {
    console.error("🚨 /balance error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error while fetching balance" });
  }
});

// ---------- Health Check ----------
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 CORS origin: ${FRONTEND_ORIGIN}`);
});
