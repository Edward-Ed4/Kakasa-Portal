const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { db } = require("./store");
const { canonicalRecord, fingerprint, merkleRoot, makeId, makeCode } = require("./integrity");
const { seedDemo } = require("./seed");

seedDemo();

const root = path.resolve(__dirname, "..");
const validators = ["UMRA Observer", "Uganda Co-operative Alliance", "Makerere CoCIS", "Independent Audit Partner"];
const allowedTypes = new Set(["DEPOSIT", "WITHDRAWAL", "LOAN_REPAYMENT"]);
const forbiddenFields = new Set(["name", "memberName", "phone", "phoneNumber", "email", "nationalId", "nin", "address"]);
const saccoReferencePrefixes = { "market-vendors": "MV", "boda-riders": "BB", "craft-savers": "CS" };
const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function send(response, status, value, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", chunk => {
      body += chunk;
      if (body.length > 65536) {
        reject(Object.assign(new Error("Request body exceeds 64 KB."), { status: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw Object.assign(new Error("Request body must be a JSON object."), { status: 400 });
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error("Request body must be a valid JSON object."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function getApiKey(request) {
  const authorization = request.headers.authorization || "";
  return request.headers["x-api-key"] || authorization.replace(/^Bearer\s+/i, "");
}

function authorizeCommit(request) {
  const keyCount = db.prepare("SELECT COUNT(*) AS count FROM api_keys").get().count;
  if (!keyCount) return true;
  const key = getApiKey(request);
  if (!key) return false;
  const digest = crypto.createHash("sha256").update(key).digest("hex");
  return Boolean(db.prepare("SELECT id FROM api_keys WHERE key_hash = ?").get(digest));
}

function createCommit(body, request) {
  if (!authorizeCommit(request)) {
    const error = new Error("A valid API key is required. Send it as X-API-Key or a Bearer token.");
    error.status = 401;
    throw error;
  }
  const unknown = Object.keys(body).filter(key => !["saccoId", "memberRef", "type", "amountUgx", "occurredAt", "reference"].includes(key));
  const pii = unknown.filter(key => forbiddenFields.has(key) || /name|phone|email|address|national.?id|(^|_)nin/i.test(key));
  if (pii.length) {
    const error = new Error(`Personal member fields are not accepted: ${pii.join(", ")}. Use a pseudonymous memberRef.`);
    error.status = 400;
    throw error;
  }
  if (unknown.length) {
    const error = new Error(`Unsupported fields: ${unknown.join(", ")}.`);
    error.status = 400;
    throw error;
  }
  const { saccoId, memberRef, type, amountUgx, occurredAt, reference } = body;
  if (typeof saccoId !== "string" || !db.prepare("SELECT id FROM saccos WHERE id = ?").get(saccoId)) {
    const error = new Error("saccoId must identify a configured SACCO.");
    error.status = 400;
    throw error;
  }
  if (typeof memberRef !== "string" || !/^MEM-\d{4,8}$/.test(memberRef)) {
    const error = new Error("memberRef must be a pseudonymous code such as MEM-4512.");
    error.status = 400;
    throw error;
  }
  if (!allowedTypes.has(type)) {
    const error = new Error("type must be DEPOSIT, WITHDRAWAL, or LOAN_REPAYMENT.");
    error.status = 400;
    throw error;
  }
  if (!Number.isSafeInteger(amountUgx) || amountUgx <= 0) {
    const error = new Error("amountUgx must be a positive whole number of Ugandan shillings.");
    error.status = 400;
    throw error;
  }
  const parsedDate = typeof occurredAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(occurredAt)
    ? new Date(`${occurredAt}T00:00:00Z`)
    : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== occurredAt) {
    const error = new Error("occurredAt must be a date in YYYY-MM-DD format.");
    error.status = 400;
    throw error;
  }
  if (typeof reference !== "string" || !new RegExp(`^${saccoReferencePrefixes[saccoId]}-\\d{4,8}$`).test(reference)) {
    const error = new Error("reference must be a non-personal SACCO transaction code, such as MV-1009.");
    error.status = 400;
    throw error;
  }
  const record = { saccoId, memberRef, type, amountUgx, occurredAt, reference };
  const receiptId = makeId("KKS");
  const now = new Date().toISOString();
  let code = makeCode();
  while (db.prepare("SELECT code FROM transactions WHERE code = ?").get(code)) code = makeCode();
  const hash = fingerprint(record);
  db.prepare(`
    INSERT INTO transactions (receipt_id, code, sacco_id, member_ref, record_json, fingerprint, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(receiptId, code, saccoId, memberRef, canonicalRecord(record), hash, now);
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const protocol = forwardedProto === "https" ? "https" : "http";
  const baseUrl = `${protocol}://${request.headers.host || "localhost:3000"}`;
  return {
    receiptId,
    verificationCode: code,
    fingerprint: hash,
    status: "QUEUED",
    qrPayload: { url: `${baseUrl}/?verify=${code}`, receiptId, code },
    message: "Accepted for batch sealing. No personal member details are included in the verification payload."
  };
}

function sealBatch() {
  const pending = db.prepare(`
    SELECT t.receipt_id, t.fingerprint FROM transactions t
    LEFT JOIN anchor_items i ON i.receipt_id = t.receipt_id
    WHERE i.receipt_id IS NULL ORDER BY t.created_at, t.receipt_id
  `).all();
  if (pending.length === 0) return { sealed: false, message: "There are no pending commitments to seal." };
  const batchFingerprints = pending.map(item => item.fingerprint);
  const rootHash = merkleRoot(batchFingerprints);
  const anchorId = makeId("ANCHOR");
  const now = new Date().toISOString();
  const validatorResults = validators.map(name => ({ name, status: "CONFIRMED", root: rootHash }));
  const transaction = db.prepare("SELECT receipt_id, fingerprint FROM transactions WHERE receipt_id = ?");
  const insertAnchorItem = db.prepare("INSERT INTO anchor_items (receipt_id, anchor_id, fingerprint, sacco_id) VALUES (?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO anchors (id, merkle_root, tx_count, validators_json, sealed_at) VALUES (?, ?, ?, ?, ?)")
      .run(anchorId, rootHash, pending.length, JSON.stringify(validatorResults), now);
    for (const item of pending) {
      const current = transaction.get(item.receipt_id);
      insertAnchorItem.run(item.receipt_id, anchorId, current.fingerprint, db.prepare("SELECT sacco_id FROM transactions WHERE receipt_id = ?").get(item.receipt_id).sacco_id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const resolved = db.prepare("UPDATE alerts SET status = 'RESOLVED', note = ?, approved_by = 'Batch sealing', updated_at = ? WHERE receipt_id = ? AND status = 'UNANCHORED'");
  for (const item of pending) resolved.run("Automatically cleared when the pending transaction was sealed by the validator quorum.", now, item.receipt_id);
  return { sealed: true, anchorId, merkleRoot: rootHash, transactionCount: pending.length, validators: validatorResults, sealedAt: now };
}

function reconcile() {
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT t.receipt_id, t.sacco_id, t.fingerprint AS current_fingerprint, i.fingerprint AS sealed_fingerprint
    FROM transactions t LEFT JOIN anchor_items i ON i.receipt_id = t.receipt_id
    WHERE t.deleted_at IS NULL
  `).all();
  const anchored = db.prepare("SELECT receipt_id, sacco_id FROM anchor_items").all();
  const currentIds = new Set(rows.map(row => row.receipt_id));
  const sealedIds = new Set(anchored.map(row => row.receipt_id));
  const issues = [];
  for (const row of rows) {
    if (!row.sealed_fingerprint) {
      issues.push({ receiptId: row.receipt_id, saccoId: row.sacco_id, status: "UNANCHORED", details: "Transaction is in the SACCO database but has not been sealed." });
    } else if (row.current_fingerprint !== row.sealed_fingerprint) {
      issues.push({ receiptId: row.receipt_id, saccoId: row.sacco_id, status: "MODIFIED", details: "Current SACCO record does not match the sealed SHA-256 fingerprint." });
    }
  }
  for (const row of anchored) {
    if (!currentIds.has(row.receipt_id) && sealedIds.has(row.receipt_id)) {
      issues.push({ receiptId: row.receipt_id, saccoId: row.sacco_id, status: "DELETED", details: "Sealed transaction is missing from the current SACCO database." });
    }
  }
  const openAlert = db.prepare("SELECT id FROM alerts WHERE receipt_id = ? AND status != 'RESOLVED' ORDER BY created_at DESC LIMIT 1");
  const insertAlert = db.prepare("INSERT INTO alerts (id, receipt_id, sacco_id, status, details, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const updateAlert = db.prepare("UPDATE alerts SET status = ?, details = ?, updated_at = ? WHERE id = ?");
  const resolveAlert = db.prepare("UPDATE alerts SET status = 'RESOLVED', note = ?, approved_by = 'Automated reconciliation', updated_at = ? WHERE id = ?");
  const issueByReceipt = new Map(issues.map(issue => [issue.receiptId, issue]));
  let created = 0;
  for (const issue of issues) {
    const current = openAlert.get(issue.receiptId);
    if (current) updateAlert.run(issue.status, issue.details, now, current.id);
    else {
      insertAlert.run(makeId("ALT"), issue.receiptId, issue.saccoId, issue.status, issue.details, now, now);
      created++;
    }
  }
  for (const alert of db.prepare("SELECT id, receipt_id FROM alerts WHERE status != 'RESOLVED'").all()) {
    if (!issueByReceipt.has(alert.receipt_id)) {
      resolveAlert.run("Automatically cleared: the latest reconciliation matches the sealed state.", now, alert.id);
    }
  }
  return { checked: rows.length, discrepancies: issues.length, newAlerts: created, reconciledAt: now };
}

function dashboard() {
  const txCount = db.prepare("SELECT COUNT(*) AS count FROM transactions").get().count;
  const sealedCount = db.prepare("SELECT COUNT(*) AS count FROM anchor_items").get().count;
  const openAlerts = db.prepare("SELECT COUNT(*) AS count FROM alerts WHERE status != 'RESOLVED'").get().count;
  const mismatches = db.prepare(`
    SELECT COUNT(*) AS count FROM anchor_items i LEFT JOIN transactions t ON t.receipt_id = i.receipt_id
    WHERE t.deleted_at IS NOT NULL OR t.receipt_id IS NULL OR t.fingerprint != i.fingerprint
  `).get().count;
  const latestAnchor = db.prepare("SELECT id, merkle_root, tx_count, sealed_at FROM anchors ORDER BY sealed_at DESC LIMIT 1").get() || null;
  return {
    stats: { transactions: txCount, sealed: sealedCount, matchRate: sealedCount ? Math.round((sealedCount - mismatches) / sealedCount * 100) : 100, openAlerts },
    saccos: db.prepare("SELECT id, name, tier, district FROM saccos ORDER BY name").all(),
    validators: validators.map((name, index) => ({ name, status: "ONLINE", node: `node-${index + 1}` })),
    latestAnchor
  };
}

function transactions() {
  return db.prepare(`
    SELECT t.receipt_id AS receiptId, t.code, t.sacco_id AS saccoId, s.name AS sacco,
      t.member_ref AS memberRef, json_extract(t.record_json, '$.type') AS type,
      json_extract(t.record_json, '$.amountUgx') AS amountUgx,
      json_extract(t.record_json, '$.occurredAt') AS occurredAt, t.fingerprint,
      CASE WHEN i.receipt_id IS NULL THEN 'PENDING' ELSE 'SEALED' END AS status,
      t.created_at AS createdAt
    FROM transactions t JOIN saccos s ON s.id = t.sacco_id
    LEFT JOIN anchor_items i ON i.receipt_id = t.receipt_id
    WHERE t.deleted_at IS NULL
    ORDER BY t.created_at DESC, t.receipt_id DESC LIMIT 100
  `).all();
}

function publicVerification(identifier) {
  if (!identifier) {
    const error = new Error("Provide a receiptId or six-character code.");
    error.status = 400;
    throw error;
  }
  const row = db.prepare(`
    SELECT t.receipt_id, t.code, t.fingerprint, t.sacco_id, t.record_json, i.fingerprint AS sealed_fingerprint,
      a.merkle_root, a.sealed_at, s.name AS sacco, t.deleted_at
    FROM transactions t JOIN saccos s ON s.id = t.sacco_id
    LEFT JOIN anchor_items i ON i.receipt_id = t.receipt_id
    LEFT JOIN anchors a ON a.id = i.anchor_id
    WHERE t.code = ? OR t.receipt_id = ?
  `).get(identifier.toUpperCase(), identifier.toUpperCase());
  if (!row) return { found: false, status: "NOT_FOUND", message: "No transaction matches that receipt or code." };
  const record = JSON.parse(row.record_json);
  let status = "PENDING";
  if (row.deleted_at) status = "TAMPERED";
  else if (row.sealed_fingerprint) status = row.fingerprint === row.sealed_fingerprint ? "VALID" : "TAMPERED";
  return {
    found: true,
    status,
    receiptId: row.receipt_id,
    sacco: row.sacco,
    type: record.type,
    amountUgx: record.amountUgx,
    occurredAt: record.occurredAt,
    fingerprint: row.fingerprint,
    sealedFingerprint: row.sealed_fingerprint || null,
    merkleRoot: row.merkle_root || null,
    sealedAt: row.sealed_at || null,
    message: status === "VALID" ? "This transaction matches its sealed commitment." : status === "TAMPERED" ? "The current record does not match its sealed commitment. Contact your SACCO." : "This transaction is queued and has not been sealed yet."
  };
}

function exportReport(response) {
  const rows = db.prepare(`
    SELECT a.id, a.receipt_id, s.name AS sacco, a.status, a.details, a.note, a.approved_by, a.created_at, a.updated_at
    FROM alerts a JOIN saccos s ON s.id = a.sacco_id ORDER BY a.created_at DESC
  `).all();
  const columns = ["alertId", "receiptId", "sacco", "status", "details", "boardNote", "approvedBy", "createdAt", "updatedAt"];
  const csv = [columns.join(","), ...rows.map(row => [
    row.id, row.receipt_id, row.sacco, row.status, row.details, row.note || "", row.approved_by || "", row.created_at, row.updated_at
  ].map(value => `"${String(value).replaceAll('"', '""')}"`).join(","))].join("\r\n");
  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="kakasa-integrity-report.csv"',
    "Cache-Control": "no-store"
  });
  response.end(csv);
}

function staticFile(response, requestPath) {
  const relative = requestPath === "/" ? "frontend/index.html" : path.normalize(requestPath).replace(/^[/\\]+/, "");
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    send(response, 404, { error: "Not found." });
    return;
  }
  response.writeHead(200, { "Content-Type": mimeTypes[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const method = request.method;
  try {
    if (method === "GET" && url.pathname === "/api/dashboard") return send(response, 200, dashboard());
    if (method === "GET" && url.pathname === "/api/transactions") return send(response, 200, { transactions: transactions() });
    if (method === "GET" && url.pathname === "/api/alerts") {
      return send(response, 200, { alerts: db.prepare(`
        SELECT a.id, a.receipt_id AS receiptId, a.sacco_id AS saccoId, s.name AS sacco,
          a.status, a.details, a.note, a.approved_by AS approvedBy, a.created_at AS createdAt, a.updated_at AS updatedAt
        FROM alerts a JOIN saccos s ON s.id = a.sacco_id ORDER BY a.created_at DESC LIMIT 100
      `).all() });
    }
    if (method === "GET" && url.pathname === "/api/verify") {
      return send(response, 200, publicVerification(url.searchParams.get("code") || url.searchParams.get("receiptId")));
    }
    if (method === "GET" && url.pathname === "/api/keys") {
      return send(response, 200, { keys: db.prepare("SELECT id, label, key_prefix AS prefix, created_at AS createdAt FROM api_keys ORDER BY created_at DESC").all() });
    }
    if (method === "GET" && url.pathname === "/api/report.csv") return exportReport(response);
    if (method === "POST" && url.pathname === "/v1/commit") return send(response, 202, createCommit(await readBody(request), request));
    if (method === "POST" && url.pathname === "/api/seal") return send(response, 200, sealBatch());
    if (method === "POST" && url.pathname === "/api/reconcile") return send(response, 200, reconcile());
    if (method === "POST" && url.pathname === "/api/verify/sms") {
      const body = await readBody(request);
      const match = typeof body.message === "string" && body.message.trim().match(/^KAKASA\s+([A-Z0-9-]+)$/i);
      if (!match) return send(response, 400, { error: 'SMS format: "KAKASA 7Q4M2X".' });
      return send(response, 200, publicVerification(match[1]));
    }
    if (method === "POST" && url.pathname === "/api/tamper") {
      const body = await readBody(request);
      if (typeof body.receiptId !== "string") return send(response, 400, { error: "receiptId must be a string." });
      const row = db.prepare("SELECT receipt_id, record_json FROM transactions WHERE receipt_id = ?").get(body.receiptId);
      if (!row) return send(response, 404, { error: "Transaction not found." });
      if (body.action === "delete") {
        db.prepare("UPDATE transactions SET deleted_at = ? WHERE receipt_id = ?").run(new Date().toISOString(), row.receipt_id);
      } else if (body.action === "modify") {
        const record = JSON.parse(row.record_json);
        const amountUgx = body.amountUgx === undefined ? record.amountUgx + 10000 : Number(body.amountUgx);
        if (!Number.isSafeInteger(amountUgx) || amountUgx <= 0) return send(response, 400, { error: "amountUgx must be a positive whole number." });
        record.amountUgx = amountUgx;
        db.prepare("UPDATE transactions SET record_json = ?, fingerprint = ? WHERE receipt_id = ?").run(canonicalRecord(record), fingerprint(record), row.receipt_id);
      } else {
        return send(response, 400, { error: 'action must be "modify" or "delete".' });
      }
      return send(response, 200, { simulated: true, receiptId: row.receipt_id, action: body.action });
    }
    if (method === "POST" && url.pathname === "/api/alerts/resolve") {
      const body = await readBody(request);
      if (typeof body.alertId !== "string" || typeof body.approvedBy !== "string" || body.approvedBy.trim().length < 2 || typeof body.note !== "string" || body.note.trim().length < 8) {
        return send(response, 400, { error: "Provide a board approver and an audit note of at least 8 characters." });
      }
      const result = db.prepare("UPDATE alerts SET status = 'RESOLVED', note = ?, approved_by = ?, updated_at = ? WHERE id = ? AND status != 'RESOLVED'")
        .run(body.note.trim(), body.approvedBy.trim(), new Date().toISOString(), body.alertId);
      if (!result.changes) return send(response, 404, { error: "Open alert not found." });
      return send(response, 200, { resolved: true, alertId: body.alertId });
    }
    if (method === "POST" && url.pathname === "/api/keys") {
      const body = await readBody(request);
      if (typeof body.label !== "string" || body.label.trim().length < 2) return send(response, 400, { error: "Provide a descriptive API key label." });
      const key = `kakasa_demo_${crypto.randomBytes(24).toString("base64url")}`;
      const id = makeId("KEY");
      const prefix = key.slice(0, 17);
      db.prepare("INSERT INTO api_keys (id, label, key_prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, body.label.trim().slice(0, 64), prefix, crypto.createHash("sha256").update(key).digest("hex"), new Date().toISOString());
      return send(response, 201, { id, label: body.label.trim(), prefix, key, warning: "Copy this key now; it cannot be shown again." });
    }
    if (method === "DELETE" && url.pathname.startsWith("/api/keys/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/keys/".length));
      const result = db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
      return result.changes ? send(response, 200, { deleted: true }) : send(response, 404, { error: "API key not found." });
    }
    if (method === "GET" && (url.pathname === "/" || url.pathname === "/styles.css" || url.pathname === "/app.js" || url.pathname === "/static-demo.js" || url.pathname.startsWith("/frontend/"))) return staticFile(response, url.pathname);
    return send(response, 404, { error: "Not found." });
  } catch (error) {
    if (response.headersSent || response.destroyed) return;
    console.error(error);
    return send(response, error.status || 500, { error: error.message || "Internal server error." });
  }
});

const reconciliationInterval = Number(process.env.RECONCILIATION_INTERVAL_MS || 60_000);
if (reconciliationInterval > 0) {
  const worker = setInterval(() => {
    try {
      reconcile();
    } catch (error) {
      console.error("Scheduled reconciliation failed:", error);
    }
  }, reconciliationInterval);
  worker.unref();
}

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => console.log(`KakasaPortal running at http://localhost:${port}`));

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
