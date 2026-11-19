# KakasaPortal

A locally runnable, full-stack prototype for detecting changes to SACCO transaction records without replacing existing SACCO software. The demo uses a local SQLite database and a simulated private validator network; it is **not** a production blockchain or a live integration.

## Requirements and start

- Node.js 22.13 or newer (the project uses Node's built-in `node:sqlite`; no package installation is required).
- From the project folder, run:

```powershell
npm start
```

Open [http://localhost:3000](http://localhost:3000). On first start the server creates `db/kakasa.sqlite` and seeds fictional transactions for Demo Market Vendors SACCO, Demo Boda-Boda Riders SACCO, and Demo Craft & Savings SACCO. A reconciliation worker runs every 60 seconds by default, and reconciliation can also be started on demand in the UI or API. Seed explicitly with `npm run seed` if needed; it only seeds an empty database. Set `PORT` or `KAKASA_DB_PATH` to use another local port or database file.

## Deploy the class demo to Render

The root `render.yaml` defines a free Node web service with an API health check. To deploy, sign in to Render, choose **New → Blueprint**, connect `Edward-Ed4/Kakasa-Portal`, and create the `kakasa-portal-demo` service from this repository's `render.yaml`. Render builds from `main`; once the deployment is healthy, open its `onrender.com` service URL. The listener binds to the host Render assigns and receipt links use the forwarded HTTPS scheme.

**Free-tier limitation:** this service uses SQLite on ephemeral storage. Render may stop a free service while idle, and its database can be reset on restart or redeploy; the fictional seed records are recreated at startup. The hosted demo has no board-user authentication and its sample data and write actions are publicly reachable. Use only this fictional class demo—never enter real member data or API secrets. Persistent storage requires a paid hosting configuration.

## Public lecturer demo

The GitHub Pages deployment publishes `frontend/` as a browser-only demo at [https://edward-ed4.github.io/Kakasa-Portal/](https://edward-ed4.github.io/Kakasa-Portal/). It keeps the same receipt verification, commit, seal, reconciliation, tamper, board-note, and report flows; demo changes are stored in that visitor's browser and do not call the Node API or synchronize between visitors. This is a safe fallback when the Node host is unreachable from a network. The Render deployment above is the actual Node API. Both deployments use fictional data only.

## Demo walkthrough

1. **Member check:** Open **Member verify**, enter `7Q4M2X`, and check the sealed demo deposit. Switch to **SMS simulator** and send `KAKASA 7Q4M2X` to exercise the feature-phone lookup.
2. **Commit a record:** Open **Vendor portal** and select **Send sample transaction**. The API returns a receipt ID, a six-character code, a SHA-256 fingerprint, and a QR payload. The new record is queued and does not appear on the simulated ledger until sealed.
3. **Seal a batch:** Return to **Overview** and select **Seal pending batch**. The demo computes a Merkle root over the pending fingerprints and records confirmation from four simulated validator organizations.
4. **Detect tampering:** In **Transactions**, use **Edit** or **Delete** beside a record. This simulates an insider changing or removing the live SACCO record while preserving its receipt and sealed commitment. Run reconciliation from **Overview** or **Integrity alerts**. The alert register identifies the `MODIFIED` or `DELETED` record; verifying its code reports `TAMPERED`.
5. **Resolve and report:** From **Integrity alerts**, select **Add board note & resolve**, enter an approver and a board-approved audit note, then export the Integrity Report as CSV.
6. **Create and use an API key (optional):** In **Vendor portal**, select **Create API key**. Copy the one-time key from the response panel. The key is saved in this browser for sandbox calls, and subsequent `POST /v1/commit` requests require it. Revoke the key from the same panel.

## API

### `POST /v1/commit`

Accepts only pseudonymous references and transaction fields. Personal names, phone numbers, emails, addresses, national IDs, and unknown fields are rejected. No member PII is included in the Merkle leaves, QR payload, verification response, or integrity report.

```json
{
  "saccoId": "market-vendors",
  "memberRef": "MEM-4512",
  "type": "DEPOSIT",
  "amountUgx": 250000,
  "occurredAt": "2026-11-19",
  "reference": "MV-1009"
}
```

Example response (`202 Accepted`):

```json
{
  "receiptId": "KKS-EXAMPLE",
  "verificationCode": "7Q4M2X",
  "fingerprint": "<sha256>",
  "status": "QUEUED",
  "qrPayload": {
    "url": "http://localhost:3000/?verify=7Q4M2X",
    "receiptId": "KKS-EXAMPLE",
    "code": "7Q4M2X"
  }
}
```

When an API key exists, send it using `X-API-Key: <key>` or `Authorization: Bearer <key>`. Keys are stored as SHA-256 hashes and shown only once.

### Other demo endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/dashboard` | SACCOs, validator status, and integrity metrics |
| `GET` | `/api/transactions` | Current SACCO transaction records |
| `GET` | `/api/alerts` | Open and resolved reconciliation findings |
| `GET` | `/api/verify?code=7Q4M2X` | Receipt/code verification without member PII |
| `POST` | `/api/verify/sms` | SMS-style lookup with `{"message":"KAKASA 7Q4M2X"}` |
| `POST` | `/api/seal` | Seal all pending fingerprints in one Merkle batch |
| `POST` | `/api/reconcile` | Compare current SACCO records with sealed fingerprints |
| `POST` | `/api/tamper` | Simulate `{"receiptId":"…","action":"modify"}` or `"delete"` |
| `POST` | `/api/alerts/resolve` | Record `alertId`, `approvedBy`, and a board `note` |
| `GET` | `/api/report.csv` | Download the Integrity Report |
| `GET`, `POST` | `/api/keys` | List key metadata or create a key |
| `DELETE` | `/api/keys/{id}` | Revoke a key by ID |

## Architecture and data boundaries

- `backend/` contains the Node HTTP API, SQLite store, hashing/Merkle helpers, and fictional seed data.
- `frontend/` contains the responsive single-page board/auditor, member verification, and vendor portal views.
- `db/` holds the local SQLite database generated at runtime.
- The transaction fingerprint is SHA-256 over a fixed-order JSON representation of the SACCO ID, pseudonymous member reference, transaction type, amount, date, and non-personal SACCO reference. Merkle parent hashes are SHA-256 over concatenated child hashes.
- Four named demo validators confirm each root. This is a local simulation, not real distributed consensus; it uses no cryptocurrency.
- The `Edit` and `Delete` controls alter or soft-delete the demo's current SACCO record while preserving the original receipt and seal for comparison.
- This prototype has no production authentication for board/vendor workspace actions, no actual SMS gateway, QR image renderer, external SACCO database connector, regulator integration, or deployment hardening. Do not use it with real member data or as a production security control.

## Tests

```powershell
npm test
```

The test suite starts an isolated server/database and checks seeded verification, privacy-field rejection, queueing, batch sealing, modified/deleted reconciliation, board-note resolution, report export, and API-key enforcement.
