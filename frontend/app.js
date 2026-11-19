const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const savedKeyName = "kakasa-demo-api-key";
let activeView = "dashboard";
let verifyMode = "app";
let toastTimer;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function money(amount) {
  return `UGX ${Number(amount).toLocaleString("en-UG")}`;
}

function readableType(type) {
  return ({ DEPOSIT: "Deposit", WITHDRAWAL: "Withdrawal", LOAN_REPAYMENT: "Loan repayment" })[type] || type;
}

function dateLabel(value) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function statusPill(status) {
  const className = String(status).toLowerCase().replaceAll("_", "-");
  return `<span class="status-pill ${escapeHtml(className)}">${escapeHtml(status)}</span>`;
}

function notify(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.style.background = error ? "#8b3e38" : "";
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3300);
}

async function api(url, options = {}) {
  if (window.KAKASA_STATIC_DEMO) return window.kakasaStaticApi(url, options);
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  if (localStorage.getItem(savedKeyName)) headers["X-API-Key"] = localStorage.getItem(savedKeyName);
  const response = await fetch(url, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

function navigate(view) {
  activeView = view;
  $$(".view").forEach(section => section.classList.toggle("active", section.id === `view-${view}`));
  $$(".nav-link").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  const label = ({ dashboard: "Overview", transactions: "Transactions", alerts: "Integrity alerts", verify: "Member verify", vendor: "Vendor portal" })[view];
  $("#current-crumb").textContent = label;
}

function transactionRow(transaction, includeSacco = true) {
  return `<tr>
    <td class="receipt-cell"><strong>${escapeHtml(transaction.receiptId)}</strong><small>Code ${escapeHtml(transaction.code)}${includeSacco ? ` · ${escapeHtml(transaction.sacco)}` : ""}</small></td>
    ${includeSacco ? "" : `<td>${escapeHtml(transaction.sacco)}</td>`}
    <td class="type-cell"><strong>${escapeHtml(readableType(transaction.type))}</strong><small>${money(transaction.amountUgx)}</small></td>
    ${includeSacco ? "" : `<td>${escapeHtml(transaction.memberRef)}</td>`}
    ${includeSacco ? "" : `<td title="${escapeHtml(transaction.fingerprint)}" class="hash-cell">${escapeHtml(transaction.fingerprint.slice(0, 16))}…</td>`}
    ${includeSacco ? `<td>${escapeHtml(dateLabel(transaction.occurredAt))}</td>` : ""}
    ${includeSacco ? `<td>${statusPill(transaction.status)}</td>` : ""}
    ${includeSacco ? `<td><div class="simulate-buttons"><button class="mini-button" data-tamper="modify" data-id="${escapeHtml(transaction.receiptId)}">Edit</button><button class="mini-button" data-tamper="delete" data-id="${escapeHtml(transaction.receiptId)}">Delete</button></div></td>` : `<td>${statusPill(transaction.status)}</td><td><div class="simulate-buttons"><button class="mini-button" data-tamper="modify" data-id="${escapeHtml(transaction.receiptId)}">Edit</button><button class="mini-button" data-tamper="delete" data-id="${escapeHtml(transaction.receiptId)}">Delete</button></div></td>`}
  </tr>`;
}

function renderTransactions(transactions) {
  const recent = transactions.slice(0, 5);
  $("#recent-transactions").innerHTML = recent.length ? recent.map(item => transactionRow(item, true)).join("") : `<tr><td colspan="5" class="empty-state">No transactions found.</td></tr>`;
  $("#all-transactions").innerHTML = transactions.length ? transactions.map(item => transactionRow(item, false)).join("") : `<tr><td colspan="7" class="empty-state">No transactions found.</td></tr>`;
}

function alertBadge(status) {
  return `<span class="status-pill ${escapeHtml(String(status).toLowerCase())}">${escapeHtml(status)}</span>`;
}

function renderAlerts(alerts) {
  const open = alerts.filter(alert => alert.status !== "RESOLVED");
  $("#nav-alert-count").textContent = String(open.length);
  $("#stat-alerts").textContent = String(open.length);
  $("#alert-total").textContent = `${alerts.length} alert${alerts.length === 1 ? "" : "s"}`;
  const recent = alerts.slice(0, 4);
  $("#alert-preview").innerHTML = recent.length ? recent.map(alert => `
    <div class="alert-preview-row">
      <span class="alert-mark ${escapeHtml(alert.status)}">${alert.status === "RESOLVED" ? "✓" : "!"}</span>
      <div class="alert-summary"><strong>${escapeHtml(alert.status)} · ${escapeHtml(alert.receiptId)}</strong><small>${escapeHtml(alert.sacco)} · ${escapeHtml(alert.details)}</small></div>
      ${alertBadge(alert.status)}
    </div>`).join("") : `<div class="empty-state">No alerts yet. Use a transaction's Edit or Delete action to simulate an insider change.</div>`;
  $("#all-alerts").innerHTML = alerts.length ? alerts.map(alert => `
    <div class="alert-row">
      <div class="alert-title">${alertBadge(alert.status)}<strong>${escapeHtml(alert.receiptId)}</strong><small>${escapeHtml(alert.sacco)} · ${escapeHtml(new Date(alert.createdAt).toLocaleString())}</small></div>
      <div class="alert-details">${escapeHtml(alert.details)}</div>
      ${alert.status === "RESOLVED" ? `<div class="resolve-note"><strong>Approved by ${escapeHtml(alert.approvedBy || "System")}</strong><br>${escapeHtml(alert.note || "No resolution note.")}</div>` : `<div></div><button class="button button-outline" data-resolve="${escapeHtml(alert.id)}">Add board note & resolve</button>`}
    </div>`).join("") : `<div class="empty-state">No integrity alerts. Run reconciliation to check the current SACCO records.</div>`;
}

function renderDashboard(dashboard) {
  $("#stat-transactions").textContent = dashboard.stats.transactions.toLocaleString();
  $("#stat-sealed").textContent = dashboard.stats.sealed.toLocaleString();
  $("#stat-match").textContent = `${dashboard.stats.matchRate}%`;
  $("#latest-root").textContent = dashboard.latestAnchor ? dashboard.latestAnchor.merkle_root : "Waiting for first seal";
  $("#latest-anchor-time").textContent = dashboard.latestAnchor ? new Date(dashboard.latestAnchor.sealed_at).toLocaleString() : "No batch sealed";
  $("#validator-list").innerHTML = dashboard.validators.map((validator, index) => `
    <div class="validator"><span class="validator-icon">${["◎", "⌂", "◇", "▦"][index]}</span><div><strong>${escapeHtml(validator.name)}</strong><small>${escapeHtml(validator.node)} · ${escapeHtml(validator.status)}</small></div></div>`).join("");
  $("#sacco-list").innerHTML = dashboard.saccos.map(sacco => `
    <div class="sacco-row"><span class="sacco-avatar">${escapeHtml(sacco.name.split(" ").slice(1, 3).map(word => word[0]).join(""))}</span><div class="sacco-info"><strong>${escapeHtml(sacco.name)}</strong><small>${escapeHtml(sacco.district)} district</small></div><span class="tier-pill ${escapeHtml(sacco.tier)}">${escapeHtml(sacco.tier)}</span></div>`).join("");
}

async function refresh() {
  const [dashboard, transactionData, alertData, keyData] = await Promise.all([
    api("/api/dashboard"), api("/api/transactions"), api("/api/alerts"), api("/api/keys")
  ]);
  renderDashboard(dashboard);
  renderTransactions(transactionData.transactions);
  renderAlerts(alertData.alerts);
  renderKeys(keyData.keys);
}

async function reconcile() {
  try {
    const result = await api("/api/reconcile", { method: "POST", body: "{}" });
    await refresh();
    notify(`Reconciliation checked ${result.checked} records and found ${result.discrepancies} discrepancy(ies).`);
  } catch (error) {
    notify(error.message, true);
  }
}

async function sealBatch() {
  try {
    const result = await api("/api/seal", { method: "POST", body: "{}" });
    await refresh();
    notify(result.sealed ? `Sealed ${result.transactionCount} transaction(s) across 4 validators.` : result.message);
  } catch (error) {
    notify(error.message, true);
  }
}

function renderKeys(keys) {
  $("#api-keys").innerHTML = keys.length ? keys.map(key => `
    <div class="key-row"><span class="sacco-avatar">⌑</span><div class="key-info"><strong>${escapeHtml(key.label)}</strong><small>${escapeHtml(key.prefix)}… · ${escapeHtml(new Date(key.createdAt).toLocaleDateString())}</small></div><button class="mini-button" data-delete-key="${escapeHtml(key.id)}" data-prefix="${escapeHtml(key.prefix)}">Revoke</button></div>`).join("") : `<div class="empty-state">No API keys created. Commit endpoint is open for local demo use.</div>`;
}

async function verify(identifier, sms = false) {
  const resultElement = $("#verify-result");
  try {
    const value = sms
      ? await api("/api/verify/sms", { method: "POST", body: JSON.stringify({ message: identifier }) })
      : await api(`/api/verify?code=${encodeURIComponent(identifier)}`);
    const statusClass = ({ VALID: "valid", PENDING: "pending", TAMPERED: "tampered", NOT_FOUND: "not-found" })[value.status] || "not-found";
    const title = ({ VALID: "Transaction verified", PENDING: "Awaiting batch seal", TAMPERED: "Integrity mismatch", NOT_FOUND: "Receipt not found" })[value.status] || value.status;
    resultElement.className = `verify-result show ${statusClass}`;
    resultElement.innerHTML = `<strong>${escapeHtml(title)} · ${escapeHtml(value.status)}</strong>${escapeHtml(value.message)}${value.found ? `
      <dl><div><dt>SACCO</dt><dd>${escapeHtml(value.sacco)}</dd></div><div><dt>TRANSACTION</dt><dd>${escapeHtml(readableType(value.type))}</dd></div><div><dt>AMOUNT</dt><dd>${money(value.amountUgx)}</dd></div><div><dt>DATE</dt><dd>${escapeHtml(dateLabel(value.occurredAt))}</dd></div></dl>` : ""}`;
  } catch (error) {
    resultElement.className = "verify-result show not-found";
    resultElement.innerHTML = `<strong>Could not complete verification</strong>${escapeHtml(error.message)}`;
  }
}

async function simulateTampering(button) {
  const action = button.dataset.tamper;
  if (action === "delete" && !window.confirm("Simulate deleting this transaction from the SACCO database? The sealed audit receipt will remain available.")) return;
  try {
    await api("/api/tamper", { method: "POST", body: JSON.stringify({ receiptId: button.dataset.id, action }) });
    await reconcile();
    navigate("alerts");
  } catch (error) {
    notify(error.message, true);
  }
}

function setupEvents() {
  $$(".nav-link").forEach(button => button.addEventListener("click", () => navigate(button.dataset.view)));
  $$("[data-navigate]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.navigate)));
  document.addEventListener("click", event => {
    if (window.KAKASA_STATIC_DEMO && event.target.closest('a[href$="api/report.csv"]')) {
      event.preventDefault();
      window.kakasaStaticReport().catch(error => notify(error.message, true));
      return;
    }
    const tamperButton = event.target.closest("[data-tamper]");
    if (tamperButton) return simulateTampering(tamperButton);
    const resolveButton = event.target.closest("[data-resolve]");
    if (resolveButton) {
      $("#resolve-alert-id").value = resolveButton.dataset.resolve;
      $("#resolve-dialog").showModal();
      return;
    }
    const revokeButton = event.target.closest("[data-delete-key]");
    if (revokeButton) {
      api(`/api/keys/${encodeURIComponent(revokeButton.dataset.deleteKey)}`, { method: "DELETE" })
        .then(async () => {
          if (localStorage.getItem(savedKeyName)?.startsWith(revokeButton.dataset.prefix)) localStorage.removeItem(savedKeyName);
          await refresh();
          notify("API key revoked.");
        }).catch(error => notify(error.message, true));
    }
  });
  $("#seal-button").addEventListener("click", sealBatch);
  $("#reconcile-button").addEventListener("click", reconcile);
  $("#transactions-refresh").addEventListener("click", () => refresh().catch(error => notify(error.message, true)));
  $$('[data-action="reconcile"]').forEach(button => button.addEventListener("click", reconcile));
  $$(".verify-tab").forEach(button => button.addEventListener("click", () => {
    verifyMode = button.dataset.mode;
    $$(".verify-tab").forEach(tab => tab.classList.toggle("active", tab === button));
    $("#sms-simulator").hidden = verifyMode !== "sms";
    $("#sms-command").textContent = `KAKASA ${$("#verify-code").value.trim().toUpperCase() || "7Q4M2X"}`;
  }));
  $("#verify-code").addEventListener("input", event => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
    $("#sms-command").textContent = `KAKASA ${event.target.value || "7Q4M2X"}`;
  });
  $("#demo-code").addEventListener("click", () => {
    $("#verify-code").value = "7Q4M2X";
    $("#sms-command").textContent = "KAKASA 7Q4M2X";
  });
  $("#verify-form").addEventListener("submit", event => {
    event.preventDefault();
    const code = $("#verify-code").value.trim().toUpperCase();
    if (verifyMode === "sms") verify(`KAKASA ${code}`, true);
    else verify(code);
  });
  $("#send-sms").addEventListener("click", () => verify($("#sms-command").textContent, true));
  $("#sample-request").textContent = JSON.stringify({
    saccoId: "market-vendors",
    memberRef: "MEM-4512",
    type: "DEPOSIT",
    amountUgx: 250000,
    occurredAt: "2026-11-19",
    reference: "MV-1009"
  }, null, 2);
  $("#sample-commit").addEventListener("click", async () => {
    $("#response-status").textContent = "SENDING";
    try {
      const response = await api("/v1/commit", {
        method: "POST",
        body: JSON.stringify({
          saccoId: "market-vendors",
          memberRef: "MEM-4512",
          type: "DEPOSIT",
          amountUgx: 250000,
          occurredAt: new Date().toISOString().slice(0, 10),
          reference: `MV-${Math.floor(1000 + Math.random() * 9000)}`
        })
      });
      $("#response-status").textContent = "202 ACCEPTED";
      $("#sample-response").textContent = JSON.stringify(response, null, 2);
      await refresh();
      notify(`Receipt ${response.receiptId} queued for sealing.`);
    } catch (error) {
      $("#response-status").textContent = "ERROR";
      $("#sample-response").textContent = JSON.stringify({ error: error.message }, null, 2);
      notify(error.message, true);
    }
  });
  $("#create-key-button").addEventListener("click", async () => {
    const label = window.prompt("Label this sandbox API key (for example: Local vendor integration):");
    if (!label || label.trim().length < 2) return;
    try {
      const result = await api("/api/keys", { method: "POST", body: JSON.stringify({ label: label.trim() }) });
      localStorage.setItem(savedKeyName, result.key);
      $("#response-status").textContent = "NEW KEY · COPY NOW";
      $("#sample-response").textContent = JSON.stringify({ ...result, key: result.key }, null, 2);
      await refresh();
      notify("API key created and saved in this browser for sandbox calls.");
    } catch (error) {
      notify(error.message, true);
    }
  });
  $("#resolve-form").addEventListener("submit", async event => {
    if (event.submitter?.id !== "confirm-resolve") return;
    event.preventDefault();
    try {
      await api("/api/alerts/resolve", { method: "POST", body: JSON.stringify({
        alertId: $("#resolve-alert-id").value,
        approvedBy: $("#approved-by").value,
        note: $("#resolution-note").value
      }) });
      $("#resolve-dialog").close();
      $("#approved-by").value = "";
      $("#resolution-note").value = "";
      await refresh();
      notify("Board-approved resolution recorded in the audit trail.");
    } catch (error) {
      notify(error.message, true);
    }
  });
  const queryCode = new URLSearchParams(location.search).get("verify");
  if (queryCode) {
    navigate("verify");
    $("#verify-code").value = queryCode.toUpperCase();
    verify(queryCode);
  }
}

setupEvents();
if (window.KAKASA_STATIC_DEMO) {
  document.querySelector(".footer span").textContent = "GitHub Pages demo · Changes are saved in this browser";
}
refresh().catch(error => notify(`Could not load the local demo: ${error.message}`, true));
