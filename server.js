require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname)));

const MP_BASE = "https://api.somosmarcha.com/api/v1";
const MP_KEY = (process.env.MARCHA_API_KEY || "").trim();
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

// ── MarchaPay API ─────────────────────────────────────────────────────────────

async function mpRequest(method, endpoint, body) {
  const url = `${MP_BASE}${endpoint}`;
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Bearer ${MP_KEY}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const json = await res.json();

  if (!res.ok) {
    const err = new Error(json.message || "MarchaPay API error");
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
    const webhookSecret = process.env.MARCHA_WEBHOOK_SECRET || "";
    const postbackUrl = SITE_URL.startsWith("https://")
      ? `${SITE_URL}/api/webhooks/marcha${webhookSecret ? `?token=${webhookSecret}` : ""}`
      : undefined;

    transaction = await mpRequest("POST", "/sellers/orders/", {
      customer: {
        name: nome,
        tax_id: cpfClean || "00000000000",
        email: "cliente@diskgasdojosuel.online",
        phone: telClean || undefined,
        address: {
          street: req.body.rua || "Não informado",
          number: req.body.numero || "S/N",
          neighborhood: req.body.bairro || "Não informado",
          city: req.body.cidade || "Não informado",
          state: (req.body.estado || "SP").toUpperCase(),
          postal_code: (req.body.cep || "00000000").replace(/\D/g, ""),
        },
      },
      items: [],
      payment: { gross_amount: amountCents },
      postback_url: postbackUrl,
    });
  } catch (err) {
    console.error("MarchaPay PIX error:", err.body || err.message);
    return res.status(502).json({ sucesso: false, erro: "Falha ao gerar PIX. Tente novamente." });
  }

  // MarchaPay retorna pix.copy_and_paste e pix.qr_code_image_base64 (base64 puro, sem prefixo)
  const pixCode = transaction.pix?.copy_and_paste || "";
  const qrBase64Raw = transaction.pix?.qr_code_image_base64 || null;

  let qrImage = qrBase64Raw ? `data:image/png;base64,${qrBase64Raw}` : null;
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
      orderId: String(transaction.uuid),
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
    pending.push({ transactionId: String(transaction.uuid), createdAt, utmPayload });
    writePending(pending);
  }

  return res.json({
    sucesso: true,
    pix: pixCode,
    qr_code: qrImage,
    transacao_id: transaction.uuid,
  });
});

// ── GET /api.php?action=status&id= — consultar pagamento ─────────────────────

app.get("/api.php", async (req, res) => {
  const { action, id } = req.query;
  if (action !== "status" || !id) {
    return res.status(400).json({ erro: "Parâmetros inválidos." });
  }

  try {
    const tx = await mpRequest("GET", `/sellers/orders/${id}/`);
    const status = tx.payment?.status || tx.status || "";
    const pago = status === "PAID";
    const expirado = ["CANCELLED", "REFUNDED", "EXPIRED", "CHARGEBACK"].includes(status);
    return res.json({ pago, expirado, status });
  } catch (err) {
    console.error("MarchaPay status error:", err.body || err.message);
    return res.status(502).json({ erro: "Falha ao consultar pagamento." });
  }
});

// ── POST /api/webhooks/marcha ─────────────────────────────────────────────────

const seenWebhooks = new Set();

app.post("/api/webhooks/marcha", (req, res) => {
  // Valida token secreto na query string (MarchaPay não envia HMAC no postback por pedido)
  const webhookSecret = process.env.MARCHA_WEBHOOK_SECRET || "";
  if (webhookSecret && req.query.token !== webhookSecret) {
    return res.status(401).json({ erro: "Token inválido." });
  }

  res.json({ received: true });

  const body = req.body;
  const eventType = req.headers["x-webhook-event"] || body?.event || "";
  // Deduplica pelo X-Webhook-Event-Id (conforme docs MarchaPay)
  const eventId = req.headers["x-webhook-event-id"] || "";
  const orderUuid = String(body?.data?.order?.uuid || "");

  const dedupeKey = eventId || orderUuid;
  if (!dedupeKey || seenWebhooks.has(dedupeKey)) return;
  seenWebhooks.add(dedupeKey);

  setImmediate(async () => {
    console.log(`[webhook] event=${eventType} order=${orderUuid}`);

    const isPaid = eventType === "order.paid" || body?.data?.order?.status === "PAID";

    if (isPaid && UTMIFY_TOKEN) {
      const paidAt = body?.data?.order?.paid_at || body?.occurred_at;
      const approvedDate = paidAt ? toUtcDateTime(new Date(paidAt)) : toUtcDateTime(new Date());

      const pending = readPending();
      const row = pending.find((r) => r.transactionId === orderUuid);
      if (row) {
        await sendToUtmify({ ...row.utmPayload, status: "paid", approvedDate });
        writePending(pending.filter((r) => r.transactionId !== orderUuid));
      }
    }
  });
});

// ── Polling fallback UTMify ───────────────────────────────────────────────────

async function pollPending() {
  if (!UTMIFY_TOKEN || !MP_KEY) return;
  const pending = readPending();
  if (!pending.length) return;

  const stillPending = [];
  for (const row of pending) {
    try {
      const tx = await mpRequest("GET", `/sellers/orders/${row.transactionId}/`);
      const status = tx.payment?.status || tx.status || "";
      if (status === "PAID") {
        const paidAt = tx.timestamps?.paid_at;
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
  console.log(`MarchaPay: ${MP_BASE}`);
  if (UTMIFY_TOKEN) {
    console.log("UTMify: ativo — pedidos serão enviados ao painel.");
    setInterval(pollPending, POLL_INTERVAL_MS);
    pollPending();
  } else {
    console.warn("UTMify: UTMIFY_API_TOKEN não configurado — tracking desativado.");
  }
});
