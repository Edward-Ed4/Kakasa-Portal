const { db } = require("./store");
const { fingerprint, merkleRoot, makeCode } = require("./integrity");
const crypto = require("node:crypto");

const validators = ["Regulator", "Apex Union", "University", "Audit Firm"];

function seedDemo() {
  if (db.prepare("SELECT COUNT(*) AS count FROM saccos").get().count > 0) return false;
  const now = new Date().toISOString();
  const saccos = [
    { id: "market-vendors", name: "Demo Market Vendors SACCO", tier: "Standard", district: "Kampala" },
    { id: "boda-riders", name: "Demo Boda-Boda Riders SACCO", tier: "Pro", district: "Jinja" },
    { id: "craft-savers", name: "Demo Craft & Savings SACCO", tier: "Lite", district: "Mbarara" }
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
  console.log(`Seeded ${saccos.length} demo SACCOs and ${receiptIds.length} sealed transactions.`);
  return true;
}

function uniqueCode(findByCode) {
  let code;
  do {
    code = makeCode();
  } while (findByCode.get(code));
  return code;
}

if (require.main === module) seedDemo();

module.exports = { seedDemo };
