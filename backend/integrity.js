const crypto = require("node:crypto");

function canonicalRecord(record) {
  return JSON.stringify({
    saccoId: record.saccoId,
    memberRef: record.memberRef,
    type: record.type,
    amountUgx: record.amountUgx,
    occurredAt: record.occurredAt,
    reference: record.reference
  });
}

function fingerprint(record) {
  return crypto.createHash("sha256").update(canonicalRecord(record)).digest("hex");
}

function merkleRoot(fingerprints) {
  if (fingerprints.length === 0) return crypto.createHash("sha256").update("").digest("hex");
  let level = fingerprints.map(value => Buffer.from(value, "hex"));
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] || left;
      next.push(crypto.createHash("sha256").update(Buffer.concat([left, right])).digest());
    }
    level = next;
  }
  return level[0].toString("hex");
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

function makeCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
}

module.exports = { canonicalRecord, fingerprint, merkleRoot, makeId, makeCode };
