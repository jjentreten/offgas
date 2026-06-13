require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname)));

const BC_BASE = "https://api.blackcatpay.com.br/api";
const BC_KEY = (process.env.BLACKCAT_API_KEY || "").trim();
const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";
const UTMIFY_TOKEN = (process.env.UTMIFY_API_TOKEN || "").trim();
const SITE_URL = (process.env.SITE_URL || "http://localhost:" + (process.env.PORT || 3000)).replace(/\/$/, "");
const PENDING_FILE = path.join(__dirname, "data", "pending-utmify-orders.json");
const POLL_INTERVAL_MS = 30 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function toUtcDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function ensureDataDir() {
  const dir = path.join(__dirname, "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readPending() {
  ensureDataDir();
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")) || []; } catch { return []; }
}

function writePending(list) {
  ensureDataDir();
  fs.writeFileSync(PENDING_FILE, JSON.stringify(list), "utf8");
}

// ── BlackCat API ──────────────────────────────────────────────────────────────

async function bcRequest(method, endpoint, body) {
  const url = `${BC_BASE}${endpoint}`;
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": BC_KEY,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const json = await res.json();

  if (!res.ok || json.success === false) {
    const err = new Error(json.message || "BlackCat API error");
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json.data !== undefined ? json.data : json;
}

// ── UTMify ────────────────────────────────────────────────────────────────────

function buildUtmifyPayload({ orderId, status, createdAt, approvedDate, customer, products, tracking, totalPriceInCents }) {
  const gatewayFee = Math.round(totalPriceInCents * 0.01) || 0;
  const userCommission = Math.max(1, totalPriceInCents - gatewayFee);
  return {
    orderId: String(orderId),
    platform: "DiskGasJosuel",
    paymentMethod: "pix",
    status,
    createdAt,
    approvedDate: approvedDate || null,
    refundedAt: null,
    customer: {
      name: customer.name,
      email: customer.email || "cliente@diskgasdojosuel.online",
      phone: customer.phone || null,
      document: customer.document || null,
      country: "BR",
      ip: customer.ip || "0.0.0.0",
    },
    products: products.map((p) => ({
      id: String(p.id || p.name),
      name: p.name,
      planId: null,
      planName: null,
      quantity: p.quantity || 1,
      priceInCents: p.priceInCents,
    })),
    trackingParameters: {
      src: tracking?.src ?? null,
      sck: tracking?.sck ?? null,
      utm_source: tracking?.utm_source ?? null,
      utm_campaign: tracking?.utm_campaign ?? null,
      utm_medium: tracking?.utm_medium ?? null,
      utm_content: tracking?.utm_content ?? null,
      utm_term: tracking?.utm_term ?? null,
    },
    commission: { totalPriceInCents, gatewayFeeInCents: gatewayFee, userCommissionInCents: userCommission },
  };
}

async function sendToUtmify(payload) {
  if (!UTMIFY_TOKEN) return;
  try {
    const res = await fetch(UTMIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-token": UTMIFY_TOKEN },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) console.error(`UTMify erro ${res.status}:`, text);
    else console.log(`UTMify: pedido ${payload.orderId} → ${payload.status}`);
  } catch (err) {
    console.error("UTMify erro:", err.message);
  }
}

// ── POST /api.json — gerar PIX ────────────────────────────────────────────────
// Frontend envia: { nome, telefone, cpf, total, itens, ... }

app.post("/api.json", async (req, res) => {
  const { nome, telefone, cpf, total, itens = [] } = req.body;

  if (!nome || !total) {
    return res.status(400).json({ sucesso: false, erro: "Dados incompletos" });
  }

  const amountCents = Math.round(Number(total) * 100);
  if (amountCents <= 0) {
    return res.status(400).json({ sucesso: false, erro: "Valor inválido." });
  }

  const orderId = `dg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = toUtcDateTime(new Date());
  const cpfClean = (cpf || "").replace(/\D/g, "");
  const telClean = (telefone || "").replace(/\D/g, "");
  const tracking = req.body.tracking || {};

  let transaction;
  try {
    transaction = await bcRequest("POST", "/sales/create-sale", {
      amount: amountCents,
      currency: "BRL",
      paymentMethod: "pix",
      externalRef: orderId,
      postbackUrl: SITE_URL.startsWith("https://") ? `${SITE_URL}/api/webhooks/blackcat` : undefined,
      items: itens.length
        ? itens.map((i) => ({
            title: i.nome || i.name || "Item",
            unitPrice: Math.round((i.preco || i.price || 0) * 100),
            quantity: i.qty || i.quantidade || 1,
            tangible: true,
          }))
        : [{ title: "Pedido Disk Gás", unitPrice: amountCents, quantity: 1, tangible: true }],
      customer: {
        name: nome,
        email: "cliente@diskgasdojosuel.online",
        phone: telClean || "00000000000",
        document: { number: cpfClean || "00000000000", type: "cpf" },
      },
      shipping: {
        name: nome,
        street: req.body.rua || "Não informado",
        number: req.body.numero || "S/N",
        neighborhood: req.body.bairro || "Não informado",
        city: req.body.cidade || "Não informado",
        state: req.body.estado || "SP",
        zipCode: (req.body.cep || "00000000").replace(/\D/g, ""),
      },
      pix: { expiresInDays: 1 },
      utm_source: tracking.utm_source || null,
      utm_medium: tracking.utm_medium || null,
      utm_campaign: tracking.utm_campaign || null,
      utm_content: tracking.utm_content || null,
      utm_term: tracking.utm_term || null,
    });
  } catch (err) {
    console.error("BlackCat PIX error:", err.body || err.message);
    return res.status(502).json({ sucesso: false, erro: "Falha ao gerar PIX. Tente novamente." });
  }

  // BlackCat retorna paymentData.copyPaste e paymentData.qrCodeBase64
  const pixCode = transaction.paymentData?.copyPaste || "";
  const qrBase64 = transaction.paymentData?.qrCodeBase64 || null;

  // Usa QR da BlackCat se disponível, senão gera localmente
  let qrImage = qrBase64 || null;
  if (!qrImage && pixCode) {
    try {
      qrImage = await QRCode.toDataURL(pixCode, { width: 280, margin: 2 });
    } catch (e) {
      console.error("QR gen error:", e.message);
    }
  }

  // Envia "waiting_payment" para UTMify
  if (UTMIFY_TOKEN) {
    const clientIp = ((req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "0.0.0.0").replace(/^::ffff:/, "");
    const utmProducts = itens.length
      ? itens.map((i) => ({
          id: String(i.nome || i.name || "item"),
          name: i.nome || i.name || "Item",
          quantity: i.qty || i.quantidade || 1,
          priceInCents: Math.round((i.preco || i.price || 0) * 100),
        }))
      : [{ id: orderId, name: "Pedido Disk Gás", quantity: 1, priceInCents: amountCents }];

    const utmPayload = buildUtmifyPayload({
      orderId: String(transaction.transactionId),
      status: "waiting_payment",
      createdAt,
      approvedDate: null,
      customer: { name: nome, phone: telClean || null, document: null, ip: clientIp },
      products: utmProducts,
      tracking,
      totalPriceInCents: amountCents,
    });
    await sendToUtmify(utmPayload);

    const pending = readPending();
    pending.push({ transactionId: String(transaction.transactionId), createdAt, utmPayload });
    writePending(pending);
  }

  return res.json({
    sucesso: true,
    pix: pixCode,
    qr_code: qrImage,
    transacao_id: transaction.transactionId,
  });
});

// ── GET /api.php?action=status&id= — consultar pagamento ─────────────────────

app.get("/api.php", async (req, res) => {
  const { action, id } = req.query;
  if (action !== "status" || !id) {
    return res.status(400).json({ erro: "Parâmetros inválidos." });
  }

  try {
    const tx = await bcRequest("GET", `/sales/${id}/status`);
    const pago = tx.status === "PAID";
    const expirado = ["CANCELLED", "REFUNDED"].includes(tx.status);
    return res.json({ pago, expirado, status: tx.status });
  } catch (err) {
    console.error("BlackCat status error:", err.body || err.message);
    return res.status(502).json({ erro: "Falha ao consultar pagamento." });
  }
});

// ── POST /api/webhooks/blackcat ───────────────────────────────────────────────

const seenWebhooks = new Set();

app.post("/api/webhooks/blackcat", (req, res) => {
  res.json({ received: true });

  const event = req.body;
  // BlackCat: header X-Webhook-Event = "transaction.paid", deduplicar por transactionId
  const eventType = req.headers["x-webhook-event"] || "";
  const transactionId = String(event?.transactionId || event?.data?.transactionId || "");

  if (!transactionId || seenWebhooks.has(transactionId)) return;
  seenWebhooks.add(transactionId);

  setImmediate(async () => {
    console.log(`[webhook] event=${eventType} transactionId=${transactionId}`);

    const isPaid = eventType === "transaction.paid" || event?.status === "PAID";

    if (isPaid && UTMIFY_TOKEN) {
      const paidAt = event?.paidAt || event?.data?.paidAt;
      const approvedDate = paidAt ? toUtcDateTime(new Date(paidAt)) : toUtcDateTime(new Date());

      const pending = readPending();
      const row = pending.find((r) => r.transactionId === transactionId);
      if (row) {
        await sendToUtmify({ ...row.utmPayload, status: "paid", approvedDate });
        writePending(pending.filter((r) => r.transactionId !== transactionId));
      }
    }
  });
});

// ── Polling fallback UTMify ───────────────────────────────────────────────────

async function pollPending() {
  if (!UTMIFY_TOKEN || !BC_KEY) return;
  const pending = readPending();
  if (!pending.length) return;

  const stillPending = [];
  for (const row of pending) {
    try {
      const tx = await bcRequest("GET", `/sales/${row.transactionId}/status`);
      if (tx.status === "PAID") {
        const paidAt = tx.paidAt;
        const approvedDate = paidAt ? toUtcDateTime(new Date(paidAt)) : toUtcDateTime(new Date());
        await sendToUtmify({ ...row.utmPayload, status: "paid", approvedDate });
        console.log(`UTMify polling: ${row.transactionId} confirmado`);
      } else {
        stillPending.push(row);
      }
    } catch (err) {
      console.error("Poll error:", row.transactionId, err.message);
      stillPending.push(row);
    }
  }
  if (stillPending.length !== pending.length) writePending(stillPending);
}

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Disk Gás do Josuel rodando na porta ${PORT}`);
  console.log(`BlackCat: ${BC_BASE}`);
  if (UTMIFY_TOKEN) {
    console.log("UTMify: ativo — pedidos serão enviados ao painel.");
    setInterval(pollPending, POLL_INTERVAL_MS);
    pollPending();
  } else {
    console.warn("UTMify: UTMIFY_API_TOKEN não configurado — tracking desativado.");
  }
});
