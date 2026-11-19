(() => {
  const storageKey = "kakasa-static-demo-state-v1";
  const saccoList = [
    { id: "market-vendors", name: "Demo Market Vendors SACCO", tier: "Standard", district: "Kampala" },
    { id: "boda-riders", name: "Demo Boda-Boda Riders SACCO", tier: "Pro", district: "Jinja" },
    { id: "craft-savers", name: "Demo Craft & Savings SACCO", tier: "Lite", district: "Mbarara" }
  ];
  const validatorNames = ["Regulator", "Apex Union", "University", "Audit Firm"];
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

  const readState = () => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || "null");
    } catch (error) {
      console.error("Could not read the saved Kakasa demo:", error);
      return null;
    }
  };
  const saveState = state => localStorage.setItem(storageKey, JSON.stringify(state));
  const id = prefix => `${prefix}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const fingerprint = async record => {
    const canonical = JSON.stringify({
      saccoId: record.saccoId, memberRef: record.memberRef, type: record.type,
      amountUgx: record.amountUgx, occurredAt: record.occurredAt, reference: record.reference
    });
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  };
  const merkleRoot = async values => {
    if (!values.length) return fingerprint({});
    let level = values.map(value => Uint8Array.from(value.match(/.{2}/g), byte => parseInt(byte, 16)));
    while (level.length > 1) {
      const next = [];
      for (let index = 0; index < level.length; index += 2) {
        const left = level[index];
        const right = level[index + 1] || left;
        const joined = new Uint8Array(left.length + right.length);
        joined.set(left);
        joined.set(right, left.length);
        next.push(new Uint8Array(await crypto.subtle.digest("SHA-256", joined)));
      }
      level = next;
    }
    return [...level[0]].map(byte => byte.toString(16).padStart(2, "0")).join("");
  };
  const code = () => [...crypto.getRandomValues(new Uint8Array(6))]
    .map(byte => "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"[byte % 32]).join("");

  async function initialize() {
    const existing = readState();
    if (existing?.version === 1) return existing;
    const createdAt = new Date().toISOString();
    const transactions = [];
    for (const [saccoId, memberRef, type, amountUgx, occurredAt, reference, fixedCode] of examples) {
      const record = { saccoId, memberRef, type, amountUgx, occurredAt, reference };
      transactions.push({
        receiptId: id("KKS"), code: fixedCode || code(), saccoId, memberRef, record,
        fingerprint: await fingerprint(record), createdAt, deletedAt: null
      });
    }
    const leaves = transactions.map(transaction => transaction.fingerprint);
    const root = await merkleRoot(leaves);
    const anchorId = "ANCHOR-DEMO-0001";
    const state = {
      version: 1,
      saccos: saccoList,
      transactions,
      anchors: [{ id: anchorId, merkle_root: root, tx_count: transactions.length, sealed_at: createdAt }],
      anchorItems: transactions.map(transaction => ({
        receiptId: transaction.receiptId, anchorId, fingerprint: transaction.fingerprint, saccoId: transaction.saccoId
      })),
      alerts: [],
      keys: []
    };
    saveState(state);
    return state;
  }

  const saccoName = (state, saccoId) => state.saccos.find(sacco => sacco.id === saccoId)?.name || "Unknown SACCO";
  const findTransaction = (state, identifier) => state.transactions.find(transaction =>
    transaction.code === identifier.toUpperCase() || transaction.receiptId === identifier.toUpperCase());
  const createAlert = (state, issue, now) => {
    const current = state.alerts.find(alert => alert.receiptId === issue.receiptId && alert.status !== "RESOLVED");
    if (current) {
      current.status = issue.status;
      current.details = issue.details;
      current.updatedAt = now;
      return;
    }
    state.alerts.push({
      id: id("ALT"), receiptId: issue.receiptId, saccoId: issue.saccoId,
      status: issue.status, details: issue.details, note: null, approvedBy: null,
      createdAt: now, updatedAt: now
    });
  };
  const verify = (state, identifier) => {
    const transaction = findTransaction(state, identifier || "");
    if (!transaction) return { found: false, status: "NOT_FOUND", message: "No transaction matches that receipt or code." };
    const anchor = state.anchorItems.find(item => item.receiptId === transaction.receiptId);
    const status = transaction.deletedAt ? "TAMPERED"
      : !anchor ? "PENDING"
        : transaction.fingerprint === anchor.fingerprint ? "VALID" : "TAMPERED";
    return {
      found: true, status, receiptId: transaction.receiptId, sacco: saccoName(state, transaction.saccoId),
      ...transaction.record, fingerprint: transaction.fingerprint,
      sealedFingerprint: anchor?.fingerprint || null,
      merkleRoot: anchor ? state.anchors.find(item => item.id === anchor.anchorId)?.merkle_root || null : null,
      sealedAt: anchor ? state.anchors.find(item => item.id === anchor.anchorId)?.sealed_at || null : null,
      message: status === "VALID" ? "This transaction matches its sealed commitment."
        : status === "TAMPERED" ? "The current record does not match its sealed commitment. Contact your SACCO."
          : "This transaction is queued and has not been sealed yet."
    };
  };
  const dashboard = state => {
    const sealed = state.anchorItems.length;
    const mismatches = state.anchorItems.filter(item => {
      const transaction = state.transactions.find(row => row.receiptId === item.receiptId);
      return !transaction || transaction.deletedAt || transaction.fingerprint !== item.fingerprint;
    }).length;
    return {
      stats: {
        transactions: state.transactions.filter(transaction => !transaction.deletedAt).length,
        sealed,
        matchRate: sealed ? Math.round((sealed - mismatches) / sealed * 100) : 100,
        openAlerts: state.alerts.filter(alert => alert.status !== "RESOLVED").length
      },
      saccos: state.saccos,
      validators: validatorNames.map((name, index) => ({ name, status: "ONLINE", node: `node-${index + 1}` })),
      latestAnchor: [...state.anchors].sort((a, b) => b.sealed_at.localeCompare(a.sealed_at))[0] || null
    };
  };
  const transactions = state => state.transactions.filter(transaction => !transaction.deletedAt)
    .map(transaction => ({
      receiptId: transaction.receiptId, code: transaction.code, saccoId: transaction.saccoId,
      sacco: saccoName(state, transaction.saccoId), memberRef: transaction.memberRef,
      type: transaction.record.type, amountUgx: transaction.record.amountUgx,
      occurredAt: transaction.record.occurredAt, fingerprint: transaction.fingerprint,
      status: state.anchorItems.some(item => item.receiptId === transaction.receiptId) ? "SEALED" : "PENDING",
      createdAt: transaction.createdAt
    })).reverse();
  const alerts = state => [...state.alerts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(alert => ({
      id: alert.id, receiptId: alert.receiptId, saccoId: alert.saccoId,
      sacco: saccoName(state, alert.saccoId), status: alert.status, details: alert.details,
      note: alert.note, approvedBy: alert.approvedBy, createdAt: alert.createdAt, updatedAt: alert.updatedAt
    }));

  async function reconcile(state) {
    const now = new Date().toISOString();
    const issueByReceipt = new Map();
    for (const transaction of state.transactions) {
      const sealed = state.anchorItems.find(item => item.receiptId === transaction.receiptId);
      let issue = null;
      if (transaction.deletedAt && sealed) {
        issue = { receiptId: transaction.receiptId, saccoId: transaction.saccoId, status: "DELETED", details: "Sealed transaction is missing from the current SACCO database." };
      } else if (!transaction.deletedAt && !sealed) {
        issue = { receiptId: transaction.receiptId, saccoId: transaction.saccoId, status: "UNANCHORED", details: "Transaction is in the SACCO database but has not been sealed." };
      } else if (!transaction.deletedAt && transaction.fingerprint !== sealed.fingerprint) {
        issue = { receiptId: transaction.receiptId, saccoId: transaction.saccoId, status: "MODIFIED", details: "Current SACCO record does not match the sealed SHA-256 fingerprint." };
      }
      if (issue) {
        issueByReceipt.set(issue.receiptId, issue);
        createAlert(state, issue, now);
      }
    }
    for (const alert of state.alerts) {
      if (alert.status !== "RESOLVED" && !issueByReceipt.has(alert.receiptId)) {
        alert.status = "RESOLVED";
        alert.note = "Automatically cleared: the latest reconciliation matches the sealed state.";
        alert.approvedBy = "Automated reconciliation";
        alert.updatedAt = now;
      }
    }
    saveState(state);
    return { checked: state.transactions.filter(transaction => !transaction.deletedAt).length, discrepancies: issueByReceipt.size, newAlerts: 0, reconciledAt: now };
  }

  async function staticApi(path, options = {}) {
    const state = await initialize();
    const method = options.method || "GET";
    const url = new URL(path, location.href);
    const pathname = url.pathname;
    const json = options.body ? JSON.parse(options.body) : {};

    if (method === "GET" && pathname.endsWith("/api/dashboard")) return dashboard(state);
    if (method === "GET" && pathname.endsWith("/api/transactions")) return { transactions: transactions(state) };
    if (method === "GET" && pathname.endsWith("/api/alerts")) return { alerts: alerts(state) };
    if (method === "GET" && pathname.endsWith("/api/verify")) return verify(state, url.searchParams.get("code") || url.searchParams.get("receiptId"));
    if (method === "GET" && pathname.endsWith("/api/keys")) return {
      keys: state.keys.map(key => ({ id: key.id, label: key.label, prefix: key.prefix, createdAt: key.createdAt }))
    };
    if (method === "POST" && pathname.endsWith("/api/seal")) {
      const pending = state.transactions.filter(transaction =>
        !transaction.deletedAt && !state.anchorItems.some(item => item.receiptId === transaction.receiptId));
      if (!pending.length) return { sealed: false, message: "There are no pending commitments to seal." };
      const root = await merkleRoot(pending.map(transaction => transaction.fingerprint));
      const anchorId = id("ANCHOR");
      const now = new Date().toISOString();
      const validatorResults = validatorNames.map(name => ({ name, status: "CONFIRMED", root }));
      state.anchors.push({ id: anchorId, merkle_root: root, tx_count: pending.length, sealed_at: now });
      for (const transaction of pending) {
        state.anchorItems.push({ receiptId: transaction.receiptId, anchorId, fingerprint: transaction.fingerprint, saccoId: transaction.saccoId });
      }
      for (const alert of state.alerts) {
        if (alert.status === "UNANCHORED" && pending.some(transaction => transaction.receiptId === alert.receiptId)) {
          alert.status = "RESOLVED";
          alert.note = "Automatically cleared when the pending transaction was sealed by the validator quorum.";
          alert.approvedBy = "Batch sealing";
          alert.updatedAt = now;
        }
      }
      saveState(state);
      return { sealed: true, anchorId, merkleRoot: root, transactionCount: pending.length, validators: validatorResults, sealedAt: now };
    }
    if (method === "POST" && pathname.endsWith("/api/reconcile")) return reconcile(state);
    if (method === "POST" && pathname.endsWith("/api/verify/sms")) {
      const match = typeof json.message === "string" && json.message.trim().match(/^KAKASA\s+([A-Z0-9-]+)$/i);
      if (!match) throw new Error('SMS format: "KAKASA 7Q4M2X".');
      return verify(state, match[1]);
    }
    if (method === "POST" && pathname.endsWith("/v1/commit")) {
      const permitted = new Set(["saccoId", "memberRef", "type", "amountUgx", "occurredAt", "reference"]);
      if (Object.keys(json).some(key => !permitted.has(key))) throw new Error("Personal or unsupported fields are not accepted.");
      if (!state.saccos.some(sacco => sacco.id === json.saccoId)) throw new Error("Unknown SACCO.");
      if (!/^MEM-\d{4,8}$/.test(json.memberRef || "")) throw new Error("memberRef must be a pseudonymous code such as MEM-4512.");
      if (!["DEPOSIT", "WITHDRAWAL", "LOAN_REPAYMENT"].includes(json.type)) throw new Error("Unsupported transaction type.");
      if (!Number.isSafeInteger(json.amountUgx) || json.amountUgx <= 0) throw new Error("amountUgx must be a positive whole number.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(json.occurredAt || "")) throw new Error("occurredAt must use YYYY-MM-DD.");
      if (!/^[A-Z]{2,6}-\d{4,8}$/.test(json.reference || "")) throw new Error("reference must be a non-personal SACCO transaction code.");
      const record = { saccoId: json.saccoId, memberRef: json.memberRef, type: json.type, amountUgx: json.amountUgx, occurredAt: json.occurredAt, reference: json.reference };
      const receiptId = id("KKS");
      const verificationCode = code();
      const hash = await fingerprint(record);
      state.transactions.push({ receiptId, code: verificationCode, saccoId: json.saccoId, memberRef: json.memberRef, record, fingerprint: hash, createdAt: new Date().toISOString(), deletedAt: null });
      saveState(state);
      return {
        receiptId, verificationCode, fingerprint: hash, status: "QUEUED",
        qrPayload: { url: `${location.origin}${location.pathname}?verify=${verificationCode}`, receiptId, code: verificationCode },
        message: "Accepted for batch sealing. No personal member details are included in the verification payload."
      };
    }
    if (method === "POST" && pathname.endsWith("/api/tamper")) {
      const transaction = state.transactions.find(row => row.receiptId === json.receiptId);
      if (!transaction) throw new Error("Transaction not found.");
      if (json.action === "delete") transaction.deletedAt = new Date().toISOString();
      else if (json.action === "modify") {
        transaction.record.amountUgx = json.amountUgx === undefined ? transaction.record.amountUgx + 10000 : Number(json.amountUgx);
        transaction.fingerprint = await fingerprint(transaction.record);
      } else throw new Error('action must be "modify" or "delete".');
      saveState(state);
      return { simulated: true, receiptId: transaction.receiptId, action: json.action };
    }
    if (method === "POST" && pathname.endsWith("/api/alerts/resolve")) {
      const alert = state.alerts.find(item => item.id === json.alertId && item.status !== "RESOLVED");
      if (!alert) throw new Error("Open alert not found.");
      if (typeof json.approvedBy !== "string" || json.approvedBy.trim().length < 2 || typeof json.note !== "string" || json.note.trim().length < 8) {
        throw new Error("Provide a board approver and an audit note of at least 8 characters.");
      }
      alert.status = "RESOLVED";
      alert.approvedBy = json.approvedBy.trim();
      alert.note = json.note.trim();
      alert.updatedAt = new Date().toISOString();
      saveState(state);
      return { resolved: true, alertId: alert.id };
    }
    if (method === "POST" && pathname.endsWith("/api/keys")) {
      if (typeof json.label !== "string" || json.label.trim().length < 2) throw new Error("Provide a descriptive API key label.");
      const key = `kakasa_demo_${crypto.randomUUID().replaceAll("-", "")}`;
      const created = { id: id("KEY"), label: json.label.trim().slice(0, 64), prefix: key.slice(0, 17), createdAt: new Date().toISOString() };
      state.keys.unshift(created);
      saveState(state);
      return { ...created, key, warning: "This browser-only demo key is not a production credential." };
    }
    if (method === "DELETE" && /\/api\/keys\/[^/]+$/.test(pathname)) {
      const keyId = decodeURIComponent(pathname.split("/").pop());
      const count = state.keys.length;
      state.keys = state.keys.filter(key => key.id !== keyId);
      saveState(state);
      if (count === state.keys.length) throw new Error("API key not found.");
      return { deleted: true };
    }
    throw new Error(`Unsupported static demo action: ${method} ${pathname}`);
  }

  window.kakasaStaticApi = staticApi;
  window.kakasaStaticReport = async () => {
    const rows = alerts(await initialize());
    const columns = ["alertId", "receiptId", "sacco", "status", "details", "boardNote", "approvedBy", "createdAt", "updatedAt"];
    const csv = [columns.join(","), ...rows.map(row => [
      row.id, row.receiptId, row.sacco, row.status, row.details, row.note || "",
      row.approvedBy || "", row.createdAt, row.updatedAt
    ].map(value => `"${String(value).replaceAll('"', '""')}"`).join(","))].join("\r\n");
    const download = document.createElement("a");
    download.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    download.download = "kakasa-integrity-report.csv";
    download.click();
    URL.revokeObjectURL(download.href);
  };
})();
