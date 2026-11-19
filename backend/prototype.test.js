const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { test } = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { fingerprint, merkleRoot } = require("./integrity");

test("hashing is deterministic and Merkle roots change with leaves", () => {
  const record = { saccoId: "market-vendors", memberRef: "MEM-4512", type: "DEPOSIT", amountUgx: 250000, occurredAt: "2026-11-19", reference: "MV-1009" };
  assert.equal(fingerprint(record), fingerprint({ ...record }));
  assert.notEqual(fingerprint(record), fingerprint({ ...record, amountUgx: 250001 }));
  assert.equal(merkleRoot(["aa".repeat(32)]), "aa".repeat(32));
  assert.notEqual(merkleRoot(["aa".repeat(32), "bb".repeat(32)]), merkleRoot(["aa".repeat(32), "cc".repeat(32)]));
});

test("GitHub Pages browser demo keeps verification, sealing, and alerts functional", async () => {
  const values = new Map();
  const localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value))
  };
  const window = {};
  const context = {
    window,
    location: { hostname: "edward-ed4.github.io", origin: "https://edward-ed4.github.io", pathname: "/Kakasa-Portal/", href: "https://edward-ed4.github.io/Kakasa-Portal/" },
    localStorage,
    crypto: webcrypto,
    URL,
    TextEncoder,
    console
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "frontend", "static-demo.js"), "utf8"), context);
  const api = window.kakasaStaticApi;
  const initialDashboard = await api("/api/dashboard");
  assert.equal(initialDashboard.stats.transactions, 9);
  assert.equal(initialDashboard.stats.sealed, 8);
  assert.equal(initialDashboard.stats.openAlerts, 2);
  assert.deepEqual([...initialDashboard.saccos].map(sacco => sacco.name), [
    "Soroti Central Traders SACCO", "Jinja Boda Riders SACCO", "Mbale Farmers Savings SACCO"
  ]);
  assert.deepEqual([...initialDashboard.validators].map(validator => validator.name), [
    "UMRA Observer", "Uganda Co-operative Alliance", "Makerere CoCIS", "Independent Audit Partner"
  ]);
  assert.equal((await api("/api/verify?code=7Q4M2X")).status, "VALID");
  const sampleAlerts = (await api("/api/alerts")).alerts;
  assert.deepEqual([...sampleAlerts].map(alert => alert.status).sort(), ["MODIFIED", "UNANCHORED"]);
  const legacyState = JSON.parse(values.get("kakasa-static-demo-state-v2"));
  legacyState.version = 1;
  legacyState.saccos = [
    { id: "market-vendors", name: "Demo Market Vendors SACCO", tier: "Standard", district: "Kampala" },
    { id: "boda-riders", name: "Demo Boda-Boda Riders SACCO", tier: "Pro", district: "Jinja" },
    { id: "craft-savers", name: "Demo Craft & Savings SACCO", tier: "Lite", district: "Mbarara" }
  ];
  legacyState.transactions = legacyState.transactions.filter(transaction => transaction.record.reference !== "BB-2004");
  const legacyModified = legacyState.transactions.find(transaction => transaction.record.reference === "MV-1004");
  legacyModified.record.amountUgx = 120000;
  legacyModified.fingerprint = fingerprint(legacyModified.record);
  legacyState.alerts = [];
  const legacyValues = new Map([["kakasa-static-demo-state-v1", JSON.stringify(legacyState)]]);
  const legacyWindow = {};
  const legacyContext = {
    window: legacyWindow,
    location: context.location,
    localStorage: {
      getItem: key => legacyValues.get(key) || null,
      setItem: (key, value) => legacyValues.set(key, String(value))
    },
    crypto: webcrypto,
    URL,
    TextEncoder,
    console
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "frontend", "static-demo.js"), "utf8"), legacyContext);
  const migratedDashboard = await legacyWindow.kakasaStaticApi("/api/dashboard");
  assert.equal(migratedDashboard.stats.transactions, 9);
  assert.equal(migratedDashboard.stats.openAlerts, 2);
  assert.deepEqual([...migratedDashboard.saccos].map(sacco => sacco.name), [
    "Soroti Central Traders SACCO", "Jinja Boda Riders SACCO", "Mbale Farmers Savings SACCO"
  ]);
  await assert.rejects(api("/v1/commit", { method: "POST", body: JSON.stringify({ memberName: "Not accepted" }) }), /Personal or unsupported fields/);

  const commit = await api("/v1/commit", {
    method: "POST",
    body: JSON.stringify({ saccoId: "market-vendors", memberRef: "MEM-4512", type: "DEPOSIT", amountUgx: 250000, occurredAt: "2026-11-19", reference: "MV-1010" })
  });
  assert.equal(commit.status, "QUEUED");
  assert.match(commit.qrPayload.url, /^https:\/\/edward-ed4\.github\.io\/Kakasa-Portal\/\?verify=/);
  assert.equal((await api(`/api/verify?code=${commit.verificationCode}`)).status, "PENDING");
  await api("/api/reconcile", { method: "POST" });
  let alert = (await api("/api/alerts")).alerts.find(row => row.receiptId === commit.receiptId);
  assert.equal(alert.status, "UNANCHORED");
  await api("/api/seal", { method: "POST" });
  assert.equal((await api(`/api/verify?code=${commit.verificationCode}`)).status, "VALID");

  await api("/api/tamper", { method: "POST", body: JSON.stringify({ receiptId: commit.receiptId, action: "modify" }) });
  await api("/api/reconcile", { method: "POST" });
  assert.equal((await api(`/api/verify?code=${commit.verificationCode}`)).status, "TAMPERED");
  alert = (await api("/api/alerts")).alerts.find(row => row.receiptId === commit.receiptId);
  assert.equal(alert.status, "MODIFIED");
  await api("/api/alerts/resolve", { method: "POST", body: JSON.stringify({ alertId: alert.id, approvedBy: "Demo Chair", note: "Approved correction for demo." }) });
  assert.equal((await api("/api/alerts")).alerts.find(row => row.id === alert.id).status, "RESOLVED");

  const saved = JSON.parse(values.get("kakasa-static-demo-state-v2"));
  assert.equal(saved.transactions.some(row => row.record.memberName), false);
});

test("local prototype completes the receipt, sealing, reconciliation, and API-key flows", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kakasa-prototype-"));
  const dbPath = path.join(tempDir, "demo.sqlite");
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const selectedPort = probe.address().port;
      probe.close(() => resolve(selectedPort));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["backend/server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, PORT: String(port), KAKASA_DB_PATH: dbPath },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let serverErrors = "";
  child.stderr.setEncoding("utf8").on("data", data => { serverErrors += data; });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 2000).unref();
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Prototype server exited early: ${serverErrors}`);
    try {
      const response = await fetch(`${origin}/api/dashboard`);
      ready = response.ok;
      if (ready) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, `Server failed to start: ${serverErrors}`);

  const get = async (url, init) => {
    const response = await fetch(`${origin}${url}`, init);
    return { status: response.status, body: await response.json() };
  };
  const seeded = await get("/api/dashboard");
  assert.equal(seeded.body.stats.transactions, 9);
  assert.equal(seeded.body.stats.sealed, 8);
  assert.equal(seeded.body.stats.openAlerts, 2);
  assert.equal(seeded.body.stats.matchRate, 88);
  assert.deepEqual([...seeded.body.saccos].map(sacco => sacco.name), [
    "Jinja Boda Riders SACCO", "Mbale Farmers Savings SACCO", "Soroti Central Traders SACCO"
  ]);
  assert.deepEqual([...seeded.body.validators].map(validator => validator.name), [
    "UMRA Observer", "Uganda Co-operative Alliance", "Makerere CoCIS", "Independent Audit Partner"
  ]);
  assert.equal((await fetch(`${origin}/`)).status, 200);
  assert.equal((await fetch(`${origin}/frontend/app.js`)).status, 200);
  const logo = await fetch(`${origin}/kakasa-mark.png`);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.equal((await get("/api/verify?code=7Q4M2X")).body.status, "VALID");
  const initialAlerts = (await get("/api/alerts")).body.alerts;
  assert.deepEqual([...initialAlerts].map(alert => alert.status).sort(), ["MODIFIED", "UNANCHORED"]);
  const modifiedSample = (await get("/api/transactions")).body.transactions.find(transaction => transaction.code !== "7Q4M2X" && transaction.type === "DEPOSIT" && transaction.saccoId === "market-vendors");
  assert.ok(modifiedSample);
  assert.equal((await get(`/api/verify?code=${modifiedSample.code}`)).body.status, "TAMPERED");

  const invalidShape = await get("/v1/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null"
  });
  assert.equal(invalidShape.status, 400);
  const pii = await get("/v1/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ saccoId: "market-vendors", memberRef: "MEM-4512", memberName: "Not stored", type: "DEPOSIT", amountUgx: 10, occurredAt: "2026-11-19", reference: "MV-1010" })
  });
  assert.equal(pii.status, 400);
  assert.match(pii.body.error, /Personal member fields/);
  const personalReference = await get("/v1/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ saccoId: "market-vendors", memberRef: "MEM-4512", type: "DEPOSIT", amountUgx: 10, occurredAt: "2026-11-19", reference: "EDWARD-1234" })
  });
  assert.equal(personalReference.status, 400);

  const commitResponse = await fetch(`${origin}/v1/commit`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
    body: JSON.stringify({ saccoId: "market-vendors", memberRef: "MEM-4512", type: "DEPOSIT", amountUgx: 250000, occurredAt: "2026-11-19", reference: "MV-1011" })
  });
  const commit = { status: commitResponse.status, body: await commitResponse.json() };
  assert.equal(commit.status, 202);
  assert.equal(commit.body.status, "QUEUED");
  assert.equal(commit.body.qrPayload.code, commit.body.verificationCode);
  assert.equal(Object.hasOwn(commit.body.qrPayload, "memberRef"), false);
  assert.equal(commit.body.qrPayload.url.startsWith("https://"), true);
  assert.equal((await get(`/api/verify?code=${commit.body.verificationCode}`)).body.status, "PENDING");
  const unanchored = await get("/api/reconcile", { method: "POST" });
  assert.equal(unanchored.body.discrepancies, 3);
  assert.equal((await get("/api/alerts")).body.alerts.find(item => item.receiptId === commit.body.receiptId).status, "UNANCHORED");
  const seal = await get("/api/seal", { method: "POST" });
  assert.equal(seal.body.transactionCount, 2);
  assert.equal(seal.body.validators.length, 4);
  assert.equal((await get(`/api/verify?code=${commit.body.verificationCode}`)).body.status, "VALID");

  const modified = await get("/api/tamper", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ receiptId: commit.body.receiptId, action: "modify" })
  });
  assert.equal(modified.status, 200);
  const reconciliation = await get("/api/reconcile", { method: "POST" });
  assert.equal(reconciliation.body.discrepancies, 2);
  assert.equal((await get(`/api/verify?code=${commit.body.verificationCode}`)).body.status, "TAMPERED");
  const alert = (await get("/api/alerts")).body.alerts.find(item => item.receiptId === commit.body.receiptId);
  assert.equal(alert.status, "MODIFIED");
  const resolution = await get("/api/alerts/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alertId: alert.id, approvedBy: "Demo Board Chair", note: "Approved correction and member notification." })
  });
  assert.equal(resolution.body.resolved, true);
  const resolvedAlert = (await get("/api/alerts")).body.alerts.find(item => item.id === alert.id);
  assert.equal(resolvedAlert.status, "RESOLVED");
  assert.equal(resolvedAlert.approvedBy, "Demo Board Chair");
  assert.equal(resolvedAlert.note, "Approved correction and member notification.");

  const list = (await get("/api/transactions")).body.transactions;
  const deletionTarget = list.find(item => item.code !== commit.body.verificationCode);
  await get("/api/tamper", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ receiptId: deletionTarget.receiptId, action: "delete" })
  });
  await get("/api/reconcile", { method: "POST" });
  const deletedVerification = await get(`/api/verify?code=${deletionTarget.code}`);
  assert.equal(deletedVerification.body.status, "TAMPERED");
  const deletedAlert = (await get("/api/alerts")).body.alerts.find(item => item.receiptId === deletionTarget.receiptId);
  assert.equal(deletedAlert.status, "DELETED");
  const report = await fetch(`${origin}/api/report.csv`);
  const reportText = await report.text();
  assert.match(reportText, /DELETED/);
  assert.doesNotMatch(reportText, /MEM-\d+/);

  const createdKey = await get("/api/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "Automated test key" })
  });
  assert.equal(createdKey.status, 201);
  const deniedCommit = await get("/v1/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ saccoId: "market-vendors", memberRef: "MEM-4512", type: "DEPOSIT", amountUgx: 10, occurredAt: "2026-11-19", reference: "MV-1012" })
  });
  assert.equal(deniedCommit.status, 401);
  const authorizedCommit = await get("/v1/commit", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": createdKey.body.key },
    body: JSON.stringify({ saccoId: "market-vendors", memberRef: "MEM-4512", type: "DEPOSIT", amountUgx: 10, occurredAt: "2026-11-19", reference: "MV-1013" })
  });
  assert.equal(authorizedCommit.status, 202);
});
