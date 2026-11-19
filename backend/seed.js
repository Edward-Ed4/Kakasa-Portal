const { db } = require("./store");
const { fingerprint, merkleRoot, makeCode } = require("./integrity");
const crypto = require("node:crypto");

const validators = ["UMRA Observer", "Uganda Co-operative Alliance", "Makerere CoCIS", "Independent Audit Partner"];
const saccoNames = [
  { id: "market-vendors", name: "Soroti Central Traders SACCO", district: "Soroti" },
  { id: "boda-riders", name: "Jinja Boda Riders SACCO", district: "Jinja" },
  { id: "craft-savers", name: "Mbale Farmers Savings SACCO", district: "Mbale" }
];

function seedDemo() {
  if (db.prepare("SELECT COUNT(*) AS count FROM saccos").get().count > 0) {
    applyPilotPresentation();
    return false;
  }
  const now = new Date().toISOString();
  const saccos = [
    { ...saccoNames[0], tier: "Standard" },
    { ...saccoNames[1], tier: "Pro" },
    { ...saccoNames[2], tier: "Lite" }
  ];
  const insertSacco = db.prepare("INSERT INTO saccos (id, name, tier, district) VALUES (?, ?, ?, ?)");
  for (const sacco of saccos) insertSacco.run(sacco.id, sacco.name, sacco.tier, sacco.district);

  const examples = [
    ["market-vendors", "MEM-4512", "DEPOSIT", 250000, "2026-11-17", "MV-1001", "7Q4M2X"],
    ["market-vendors", "MEM-0184", "LOAN_REPAYMENT", 85000, "2026-11-17", "MV-1002"],
    ["market-vendors", "MEM-7291", "WITHDRAWAL", 40000, "2026-11-16", "MV-1003"],
    ["market-vendors", "MEM-3206", "DEPOSIT", 120000, "2026-11-15", "MV-1004"],
    ["boda-riders", "MEM-8340", "LOAN_REPAYMENT", 175000, "2026-11-17", "BB-2001"],
    ["boda-riders", "MEM-1945", "DEPOSIT", 55000, "2026-11-16", "BB-2002"],
    ["boda-riders", "MEM-5018", "WITHDRAWAL", 30000, "2026-11-15", "BB-2003"],
    ["craft-savers", "MEM-6632", "DEPOSIT", 200000, "2026-11-17", "CS-3001"]
  ];
  const insertTransaction = db.prepare(`
    INSERT INTO transactions (receipt_id, code, sacco_id, member_ref, record_json, fingerprint, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare("INSERT INTO anchor_items (receipt_id, anchor_id, fingerprint, sacco_id) VALUES (?, ?, ?, ?)");
  const receiptIds = [];
  const leaves = [];
  const anchorId = "ANCHOR-DEMO-0001";
  const transaction = db.prepare("SELECT receipt_id FROM transactions WHERE code = ?");
  for (const [saccoId, memberRef, type, amountUgx, occurredAt, reference, fixedCode] of examples) {
    const record = { saccoId, memberRef, type, amountUgx, occurredAt, reference };
    const hash = fingerprint(record);
    const receiptId = `KKS-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    const code = fixedCode || uniqueCode(transaction);
    insertTransaction.run(receiptId, code, saccoId, memberRef, JSON.stringify(record), hash, now);
    receiptIds.push(receiptId);
    leaves.push(hash);
  }
  const root = merkleRoot(leaves);
  db.prepare("INSERT INTO anchors (id, merkle_root, tx_count, validators_json, sealed_at) VALUES (?, ?, ?, ?, ?)")
    .run(anchorId, root, receiptIds.length, JSON.stringify(validators.map(name => ({ name, status: "ONLINE" }))), now);
  const anchorItems = db.prepare("SELECT receipt_id, fingerprint FROM transactions ORDER BY rowid");
  for (const row of anchorItems.all()) {
    const saccoId = db.prepare("SELECT sacco_id FROM transactions WHERE receipt_id = ?").get(row.receipt_id).sacco_id;
    insertItem.run(row.receipt_id, anchorId, row.fingerprint, saccoId);
  }
  applyPilotPresentation();
  console.log(`Seeded ${saccos.length} demo SACCOs and ${receiptIds.length} sealed transactions.`);
  return true;
}

function applyPilotPresentation() {
  const updateSacco = db.prepare("UPDATE saccos SET name = ?, district = ? WHERE id = ?");
  for (const sacco of saccoNames) updateSacco.run(sacco.name, sacco.district, sacco.id);

  const updateValidators = db.prepare("UPDATE anchors SET validators_json = ?");
  updateValidators.run(JSON.stringify(validators.map(name => ({ name, status: "ONLINE" }))));

  const modified = db.prepare(`
    SELECT receipt_id, sacco_id, member_ref, record_json FROM transactions
    WHERE json_extract(record_json, '$.reference') = 'MV-1004'
  `).get();
  if (!modified) throw new Error("The MV-1004 sample deposit is required for the pilot integrity alert.");
  const modifiedRecord = JSON.parse(modified.record_json);
  if (modifiedRecord.amountUgx === 120000) {
    modifiedRecord.amountUgx = 130000;
    db.prepare("UPDATE transactions SET record_json = ?, fingerprint = ? WHERE receipt_id = ?")
      .run(JSON.stringify(modifiedRecord), fingerprint(modifiedRecord), modified.receipt_id);
  }

  let unanchored = db.prepare("SELECT receipt_id, sacco_id FROM transactions WHERE json_extract(record_json, '$.reference') = 'BB-2004'").get();
  if (!unanchored) {
    const record = {
      saccoId: "boda-riders", memberRef: "MEM-4182", type: "DEPOSIT",
      amountUgx: 72000, occurredAt: "2026-11-18", reference: "BB-2004"
    };
    const receiptId = makeId("KKS");
    const insert = db.prepare(`
      INSERT INTO transactions (receipt_id, code, sacco_id, member_ref, record_json, fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(receiptId, uniqueCode(db.prepare("SELECT code FROM transactions WHERE code = ?")), record.saccoId, record.memberRef,
      JSON.stringify(record), fingerprint(record), new Date().toISOString());
    unanchored = { receipt_id: receiptId, sacco_id: record.saccoId };
  }

  const now = new Date().toISOString();
  const existingAlert = db.prepare("SELECT id, status FROM alerts WHERE receipt_id = ? ORDER BY created_at LIMIT 1");
  const insertAlert = db.prepare(`
    INSERT INTO alerts (id, receipt_id, sacco_id, status, details, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateAlert = db.prepare("UPDATE alerts SET status = ?, details = ?, updated_at = ? WHERE id = ?");
  const ensureAlert = (receiptId, saccoId, status, details) => {
    const current = existingAlert.get(receiptId);
    if (current?.status === "RESOLVED") return;
    if (current) updateAlert.run(status, details, now, current.id);
    else insertAlert.run(makeId("ALT"), receiptId, saccoId, status, details, now, now);
  };
  ensureAlert(
    modified.receipt_id,
    modified.sacco_id,
    "MODIFIED",
    "Current deposit amount differs from its sealed SHA-256 fingerprint."
  );
  ensureAlert(
    unanchored.receipt_id,
    unanchored.sacco_id,
    "UNANCHORED",
    "Deposit record is present in the SACCO ledger but has not yet been sealed."
  );
}

function uniqueCode(findByCode) {
  let code;
  do {
    code = makeCode();
  } while (findByCode.get(code));
  return code;
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

if (require.main === module) seedDemo();

module.exports = { seedDemo };
