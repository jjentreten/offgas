require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname)));

const PAGOU_BASE = (process.env.PAGOU_API_BASE_URL || "https://api.pagou.ai").replace(/\/$/, "");
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

// ── Pagou API ─────────────────────────────────────────────────────────────────

async function pagouRequest(method, endpoint, body, idempotencyKey) {
  const url = `${PAGOU_BASE}${endpoint}`;
  const headers = {
    Authorization: `Bearer ${process.env.PAGOU_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const json = await res.json();

  if (!res.ok || json.success === false) {
    const err = new Error(json.message || json.title || "Pagou API error");
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
    platform: "GasECia",
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

  let transaction;
  try {
    transaction = await pagouRequest(
      "POST",
      "/v2/transactions",
      {
        external_ref: orderId,
        amount: amountCents,
        currency: "BRL",
        method: "pix",
        description: "Pedido Gás & Cia",
        notify_url: SITE_URL.startsWith("https://") ? `${SITE_URL}/api/webhooks/pagou` : undefined,
        products: itens.length
          ? itens.map((i) => ({
              name: i.nome || i.name || "Item",
              price: Math.round((i.preco || i.price || 0) * 100),
              quantity: i.qty || i.quantidade || 1,
            }))
          : [{ name: "Pedido Gás & Cia", price: amountCents, quantity: 1 }],
        buyer: {
          name: nome,
          email: "cliente@diskgasdojosuel.online",
          phone: telClean || undefined,
          document: cpfClean ? { type: "CPF", number: cpfClean } : undefined,
        },
      },
      orderId
    );
  } catch (err) {
    console.error("Pagou PIX error:", err.body || err.message);
    return res.status(502).json({ sucesso: false, erro: "Falha ao gerar PIX. Tente novamente." });
  }

  const pixCode = transaction.pix_code || transaction.pix?.qr_code || "";

  // Gera QR localmente — pix_qr_code da Pagou pode vir null
  let qrImage = null;
  if (pixCode) {
    try {
      qrImage = await QRCode.toDataURL(pixCode, { width: 280, margin: 2, errorCorrectionLevel: "M" });
      console.log("QR gerado OK, len=", qrImage.length);
    } catch (e) {
      console.error("QR gen error:", e.message, e.stack);
    }
  } else {
    console.warn("pixCode vazio — QR não gerado. pix_code=", transaction.pix_code, "pix.qr_code=", transaction.pix?.qr_code);
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
      : [{ id: orderId, name: "Pedido Gás & Cia", quantity: 1, priceInCents: amountCents }];

    const utmPayload = buildUtmifyPayload({
      orderId: String(transaction.id),
      status: "waiting_payment",
      createdAt,
      approvedDate: null,
      customer: { name: nome, phone: telClean || null, document: null, ip: clientIp },
      products: utmProducts,
      tracking: req.body.tracking || {},
      totalPriceInCents: amountCents,
    });
    await sendToUtmify(utmPayload);

    const pending = readPending();
    pending.push({ transactionId: String(transaction.id), createdAt, utmPayload });
    writePending(pending);
  }

  return res.json({
    sucesso: true,
    pix: pixCode,
    qr_code: qrImage,
    transacao_id: transaction.id,
  });
});

// ── GET /api.php?action=status&id= — consultar pagamento ─────────────────────

app.get("/api.php", async (req, res) => {
  const { action, id } = req.query;
  if (action !== "status" || !id) {
    return res.status(400).json({ erro: "Parâmetros inválidos." });
  }

  try {
    const tx = await pagouRequest("GET", `/v2/transactions/${id}`);
    const pago = ["paid", "captured", "authorized"].includes(tx.status);
    const expirado = ["canceled", "expired", "refused", "refunded"].includes(tx.status);
    return res.json({ pago, expirado, status: tx.status });
  } catch (err) {
    console.error("Pagou status error:", err.body || err.message);
    return res.status(502).json({ erro: "Falha ao consultar pagamento." });
  }
});

// ── POST /api/webhooks/pagou ──────────────────────────────────────────────────

const seenWebhooks = new Set();

app.post("/api/webhooks/pagou", (req, res) => {
  res.json({ received: true });

  const event = req.body;
  const eventId = event?.id;
  if (!eventId || seenWebhooks.has(eventId)) return;
  seenWebhooks.add(eventId);

  setImmediate(async () => {
    // doc Pagou: roteamento por event.event + data.event_type
    const eventType = event.event || event.type || "";
    const eventSubType = event.data?.event_type || "";
    console.log(`[webhook] event=${eventType} event_type=${eventSubType} id=${eventId}`);

    const isPaid = eventType === "transaction" &&
      (eventSubType === "transaction.paid" || event.data?.status === "paid");

    if (isPaid && UTMIFY_TOKEN) {
      const transactionId = String(event.data?.id || "");
      const paidAt = event.data?.paid_at;
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
  if (!UTMIFY_TOKEN || !process.env.PAGOU_API_KEY) return;
  const pending = readPending();
  if (!pending.length) return;

  const stillPending = [];
  for (const row of pending) {
    try {
      const tx = await pagouRequest("GET", `/v2/transactions/${row.transactionId}`);
      const paid = ["paid", "captured", "authorized"].includes(tx.status);
      if (paid) {
        const paidAt = tx.paid_at;
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
  console.log(`Gás & Cia rodando na porta ${PORT}`);
  console.log(`Pagou: ${PAGOU_BASE}`);
  if (UTMIFY_TOKEN) {
    console.log("UTMify: ativo — pedidos serão enviados ao painel.");
    setInterval(pollPending, POLL_INTERVAL_MS);
    pollPending();
  } else {
    console.warn("UTMify: UTMIFY_API_TOKEN não configurado — tracking desativado.");
  }
});
