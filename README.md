# Deep Hospital — Hospital Operating System

A multi-hospital (SaaS) hospital management system that connects **Reception, OPD, Doctors, Pharmacy, IPD, Nursing, Laboratory, Radiology, Billing, Inventory, HR, Payroll, MIS and a Patient Portal** on one patient record.

```
Registration → UHID → Appointment → OPD token → Consultation → Diagnosis → Prescription
→ Pharmacy order & token → Dispensing (stock ↓) → Invoice → Payment → Lab/Radiology → IPD
→ Discharge → Follow-up → Patient mobile portal
```

Every step above is a real, database-backed workflow. It is exercised end-to-end by `npm test`.

---

## Quick start

Requirements: **Node.js 22.13+** (uses the built-in `node:sqlite`; no native build, no other database to install).

```bash
npm install
npm run dev        # development: seeds demo data on first run, restarts on change
# or
npm start          # plain start (seeds demo data only outside production)
```

Open **http://localhost:3000**.

| Where | Sign in |
|---|---|
| Staff login (`/login`) | **Super Admin:** `admin` / `123`. Pick any hospital, or "Platform console" |
| Hospital staff at *Deep Hospital Ahmedabad* | `hadmin`, `reception01`, `dr.mehta` (also `dr.shah`, `dr.patel` …), `nurse01`, `pharmacist01`, `lab01`, `pathologist01`, `radiology01`, `billing01`, `hr01`, `accounts01`, `management01`. Password `123` |
| Patient portal (`/portal`) | UHID `#000001` (Rahul Shah) / `123` |

> **These are temporary development credentials.** A banner prompts every demo user to change their password. Change it from the profile menu or **Settings → Security**. Demo data is never created when `NODE_ENV=production` (see [Production](#production-deployment)).

Useful scripts:

| Command | What it does |
|---|---|
| `npm run seed` | Deletes the local database and recreates the demo world (4 hospitals, ~95 days of activity) |
| `npm test` | Runs the end-to-end API test suite on a throw-away database |

The demo data contains four hospitals:

- **Deep Hospital Ahmedabad** (`DH-AMD`): all modules, 8 doctors, ~730 patients, 3 months of OPD/IPD/pharmacy/lab/billing/HR history, and live queues today.
- **Deep Hospital Surat** (`DH-SRT`): Laboratory module switched off, to show module isolation.
- **XYZ Multispeciality Hospital** (`XYZ-VAD`): an OPD + pharmacy clinic.
- **ABC Hospital** (`ABC-RJT`): onboarded but deactivated (subscription past due).

---

## Walk through the core workflow

1. Sign in as `reception01` and go to **Patients** → search "Kiran Joshi". Nothing is found, so click **Register patient**. The next UHID is issued (`#000xxx`) and duplicate patients are flagged while you type.
2. In the success dialog, choose a doctor and click **Generate OPD token** (`A0xx`). The patient is notified and can track the token live at `/portal`.
3. Sign in as `dr.mehta`, open **My consultations** and click **Call next**. The EMR opens with the history column, a Deep Assist summary, allergies and previous prescriptions.
4. Enter vitals (out-of-range values are flagged) and pick a diagnosis. The doctor's frequently used, favourite and recent diagnoses are listed first.
5. Hospital-approved **template suggestions** appear for the diagnosis. Added lines stay **unconfirmed** (amber). Finalizing is blocked on the server until the doctor ticks *Reviewed* on every medicine.
6. Click **Finalize & send to pharmacy**. This issues a prescription number, creates a pharmacy order with token `P-0xx` and notifies the patient.
7. Sign in as `pharmacist01` and use **Call next → Ready for pickup → Dispense & complete**. Stock is deducted first-expiry-first-out, an invoice is raised and the payment dialog opens.
8. The patient portal updates live. MIS, the dashboards and the audit log already include every step.

---

## Architecture

| Layer | Technology |
|---|---|
| Server | Node.js 22, Express 5 (only runtime dependency) |
| Database | SQLite through `node:sqlite` (WAL mode, foreign keys, 60+ normalized tables, indexed). The schema is portable to PostgreSQL |
| Frontend | Framework-free ES-module single-page app: History API router, lazy-loaded pages, hand-built SVG chart kit. No build step |
| Design | Custom design system (`public/css/app.css`): white and light-grey surfaces, medical blue, deep navy, Plus Jakarta Sans, glass header, micro-interactions, skeleton loaders, locally hosted hospital photography |

```
server/
  index.js            app factory, security headers, error handling, first-run bootstrap
  schema.sql          full relational schema (hospital_id on every tenant table)
  db.js               connection, transactions (nested savepoints), row helpers
  lib/                auth & RBAC middleware, crypto (scrypt, AES-256-GCM), sequences,
                      settings, audit, notifications, channel dispatcher, automation scheduler
  services/           domain logic shared by API + seed: patients, opd, prescriptions,
                      pharmacy, inventory, billing, clinical (IPD/lab/radiology), hr,
                      reports (29 MIS reports), assistant (Deep Assist), hospitals
  routes/             REST API: auth, platform, admin/settings, patients, opd, pharmacy,
                      clinical, billing, hr, insights (dashboard/analytics/reports/search), portal
  seed.js, seed-data.js   development demo data (Indian hospital masters, ICD-10, medicines)
public/
  index.html, css/app.css, img/ (hospital photography, favicon)
  js/core/            api client, router, UI kit, charts, icons, pickers
  js/pages/           one module per screen (dashboard, patients, opd, consult, pharmacy, ipd, …)
tests/workflow.test.js    end-to-end verification (see below)
```

### Multi-hospital (SaaS) model

- The **Super Admin** (software owner) has no hospital. From the **SaaS Console** they create hospitals, edit profile and subscription details, activate or deactivate hospitals, switch modules on or off per hospital, and **enter** any hospital's administration.
- Creating a hospital provisions a main branch, default module switches, 11 role templates with permission sets, and a hospital-admin login that must change its password.
- **Isolation:** every tenant table has `hospital_id`. Every query is scoped to the hospital bound to the server-side session, and cross-tenant IDs return 404. Usernames and all number series (UHID, IPD, tokens, invoices …) are unique per hospital.

### Roles & permissions

- Modules × actions (`view, add, edit, delete, approve, export, print, download, report`) are managed through a **visual permission matrix** per role. Custom roles are supported.
- **Per-user module overrides** (allow / deny / inherit) sit on top of roles, e.g. *Dr. Rahul: OPD ✓, Pharmacy ✗*. Deny always wins.
- Effective permissions = (role permissions ∪ user grants − user denies) ∩ modules enabled for the hospital.
- The server enforces permissions on every route with `auth.can(module, action)` middleware. The UI hides what a user cannot use, but it is never the enforcement point.
- Sensitive actions need the `approve` action: discounts, refunds, invoice cancellation, lab and radiology verification, leave approval, payroll paid, and template approval.

### Numbering (server-side, never duplicated)

| Series | Default | Notes |
|---|---|---|
| Patient UHID | `#000001` | permanent, per hospital |
| IPD | `IPD-000001` | separate from UHID |
| OPD token | `A001` | per doctor (doctor's letter), resets daily (configurable) |
| Pharmacy token | `P-001` | hospital-wide, resets daily (configurable) |
| Visit / appointment / Rx / invoice / receipt / lab / radiology / PO / GRN / employee | `OPD-`, `APT-`, `RX-`, `INV-`, `RCP-`, `LAB-`, `RAD-`, `PO-`, `GRN-`, `EMP-` | |

Numbers are generated with `UPDATE … RETURNING` inside SQLite's single-writer transaction and backed by `UNIQUE` constraints. Prefixes and padding can be changed in **Settings → Numbering**; counters are never reset or reused.

### Automation engine

Event automations run synchronously in the same database transaction as the action that triggers them:

- Registration issues the UHID. OPD registration issues the token, places the patient in the doctor's queue, raises the consultation invoice, syncs the appointment status and notifies the patient.
- A finalized prescription creates the pharmacy order, the pharmacy token and pharmacy/patient notifications, and completes the visit.
- Dispensing deducts stock first-expiry-first-out, records stock movements, raises the invoice (or IPD charges) and runs the low-stock check.
- Admission marks the bed occupied. Transfer and discharge capture room charges, produce the IPD invoice, set the bed to cleaning and publish the discharge summary.
- Lab and radiology orders enter the worklist and billing. Verification releases the report to the portal and the doctor, and critical lab values raise alerts.
- Payments recompute balance and status. Critical IPD vitals alert the doctor and the nursing station. Approved leave writes attendance.

Scheduled automations (`server/lib/automation.js`) handle:

- low-stock and expiry alerts
- appointment reminders
- follow-up reminders
- payment reminders
- scheduled MIS reports
- the notification channel dispatcher
- daily backups with retention

### Notifications

In-app notifications for staff (per user or per module audience) and patients. Outbound **SMS / WhatsApp / Email / Push** messages are queued per channel in `notification_deliveries`, can be switched on or off per hospital, and are sent by provider adapters in `server/lib/channels.js`.

Out of the box every channel uses a logging adapter, so the full pipeline can be observed. Register a real provider (MSG91, Gupshup, SMTP, FCM …) with `channels.register('sms', adapter)`.

### MIS, analytics & Deep Assist

- **29 live reports** across Patients, OPD, IPD, Pharmacy, Revenue and HR.
  - Date presets: Today, Yesterday, This week, This month, Last month, Quarter, Year, or a custom range.
  - Filters: department, doctor, new or returning patient, payment mode, status.
  - Outputs: summary KPIs, chart, sortable table. Export to **Excel** (SpreadsheetML `.xls`), **CSV**, or **PDF/Print**.
  - Reports can be saved and **scheduled** (daily, weekly or monthly, with a notification carrying the headline figures).
- **Analytics** charts: revenue growth, OPD trend, patient growth, IPD occupancy, revenue by service, pharmacy sales, a weekday × hour heatmap, a patient-journey funnel, doctor performance and department utilisation.
- **Deep Assist** (AI-assisted, clinician-controlled):
  - Natural-language MIS questions ("Show me OPD patients for August", "Which medicines are below minimum stock?") are mapped onto the audited report catalogue. No free-form SQL is run.
  - A patient-history summary built from structured records.
  - SOAP formatting of clinical notes.
  - Drafting of patient messages.
  - It never diagnoses or prescribes; prescription templates are suggestions that each need explicit confirmation.
  - The parser is deterministic and works offline. An LLM can be placed behind `assistant.interpret()` later without changing the API.

### Printing

These documents have A4 layouts, and the marked ones also have an 80 mm thermal layout. Open them from the UI and use **Print / Save PDF**:

- patient registration card
- OPD slip (thermal)
- prescription
- invoice (thermal)
- receipt (thermal)
- lab report
- radiology report
- IPD admission form
- discharge summary
- payslip
- any MIS report

### Security

- Passwords are hashed with **scrypt** and a per-password salt. Plain-text passwords are never stored. There is a minimum-length and complexity check on password change.
- Sessions:
  - Random bearer tokens, stored hashed on the server and revocable.
  - **Automatic logout** after an idle period set per hospital, plus a 12-hour absolute expiry.
  - All other sessions are revoked when a user changes their password.
- Sign-in protection: account lockout after repeated failures (configurable) and IP throttling.
- **AES-256-GCM field encryption** covers Aadhaar/ID numbers, bank accounts, PAN and employee documents. A keyed **blind index** keeps exact ID search working.
- Validation: every write goes through a declarative validator on the server, including vitals range checks, mobile/email/GSTIN/IFSC formats, and stock and balance rules.
- HTTP hardening: strict security headers (CSP without inline scripts, frame-deny, nosniff, HSTS in production).
- The **audit log** records sign-ins (successful and failed), patient create, edit and view, prescriptions, medicine changes, dispensing, billing, refunds and discounts, admissions and discharges, lab and radiology steps, user, role and permission changes, settings, exports and backups. It is filterable under **Audit Log**.
- Backups: online consistent snapshots (`VACUUM INTO`) run daily with retention. Status, database size and history are shown under **Settings → Backup**, and "Back up now" is available to administrators.

### API overview (all under `/api`, bearer-token auth)

| Area | Endpoints (selection) |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password`, `POST /auth/switch-hospital` |
| Platform | `GET/POST /platform/hospitals`, `GET/PUT /platform/hospitals/:id`, `POST /platform/hospitals/:id/status`, `PUT /platform/hospitals/:id/modules`, `GET /platform/stats` |
| Admin | `/settings`, `/departments`, `/doctors`, `/users`, `/users/:id/modules`, `/roles`, `/masters/diagnoses`, `/masters/templates`, `/masters/lab-tests`, `/masters/wards`, `/audit`, `/backup` |
| Patients | `GET/POST /patients`, `GET/PUT /patients/:id`, `/patients/:id/timeline`, `/patients/:id/summary`, `/patients/check-duplicate`, `/patients/:id/portal` |
| OPD | `/appointments` (+ `/slots`, `/:id/check-in`), `POST /opd/visit`, `POST /opd/token`, `/opd/queue/:doctorId` (+ `/call-next`), `/opd/visits/:id/emr`, `/consultation`, `/prescription`, `/finalize`, `/lab-orders`, `/radiology-orders` |
| Clinical decision support | `/diagnoses/search`, `/diagnoses/:id/favourite`, `/prescription-templates/suggest`, `/prescriptions` |
| Pharmacy & inventory | `/pharmacy/queue`, `/pharmacy/call-next`, `/pharmacy/orders/:id/status`, `POST /pharmacy/order`, `/medicines`, `/inventory/*`, `/suppliers`, `/purchase-orders` (+ `/:id/receive` GRN) |
| IPD | `/ipd/beds`, `POST /ipd/admission`, `/ipd/admissions/:id` (+ notes, vitals, medications, charges, transfer, discharge), `/nursing/dashboard` |
| Lab & radiology | `/lab/orders`, `/lab/orders/:id/status`, `/radiology/orders`, `/radiology/orders/:id/status` |
| Billing | `/billing/invoices` (+ payments, refund, discount, cancel, insurance), `/billing/payments`, `/insurance/claims` |
| HR & payroll | `/hr/employees`, `/hr/attendance`, `/hr/leaves`, `/payroll`, `/payroll/run`, `/payroll/:id/payslip` |
| Insights | `/dashboard`, `/analytics`, `/reports`, `/reports/:key?format=csv\|xls`, `/reports/saved`, `/search`, `/notifications`, `/assistant/query` |
| Patient portal | `POST /portal/login`, `GET /portal/me`, `/portal/appointments`, `/portal/slots`, `/portal/prescriptions/:id`, `/portal/invoices/:id` |

---

## Verification

`npm test` starts the real HTTP server on a fresh database and runs the following checks:

| Requirement | Verified by |
|---|---|
| Super Admin creates isolated hospitals with their own admins | ✓ |
| Reception search → register → UHID `#000001`, `#000002` | ✓ |
| Search by UHID, mobile and encrypted Aadhaar | ✓ |
| Appointment → check-in → OPD token `A001` | ✓ |
| Patient sees the token on the portal, and is notified | ✓ |
| Doctor queue, call next, EMR with allergies and history | ✓ |
| Vitals range validation | ✓ |
| Frequently used diagnoses first | ✓ |
| Approved template suggested, lines unconfirmed | ✓ |
| Server rejects finalizing unreviewed medicines; reception cannot prescribe | ✓ |
| Finalized prescription → pharmacy order + token `P-001` automatically | ✓ |
| Dispensing decreases stock (FEFO movements) | ✓ |
| Invoice → partial/full payment → balance/status recomputed; no overpayment; UPI needs a reference | ✓ |
| Portal shows the prescription and paid bill | ✓ |
| Reports, dashboard and Deep Assist reflect live data; CSV export | ✓ |
| IPD number separate from UHID; bed occupied → cleaning; IPD bill with room charges; critical vitals | ✓ |
| Permissions restrict access (pharmacist, reception, hospital admin vs platform, per-user deny, module switched off) | ✓ |
| Hospital data isolation (404 across tenants, independent UHID series) | ✓ |
| Audit log contains the important actions | ✓ |
| 25 concurrent registrations produce 25 unique UHIDs | ✓ |
| Password hashing, password change, logout and session revocation | ✓ |

The UI was also checked in headless Chromium: every screen loads with no console errors on desktop (1440 px) and mobile (390 px). The mobile checks covered the patient portal, login, dashboard and patient list.

---

## Production deployment

```bash
NODE_ENV=production \
PORT=3000 \
DATA_DIR=/var/lib/deep-hospital \
BACKUP_DIR=/var/backups/deep-hospital \
DATA_ENCRYPTION_KEY=<64 hex chars: openssl rand -hex 32> \
SUPERADMIN_USERNAME=owner \
SUPERADMIN_PASSWORD='<at least 12 characters>' \
TRUST_PROXY=true \
npm start
```

- With `NODE_ENV=production`, no demo data or demo credentials are ever created. The first start creates only the platform owner from the environment and asks them to change the password.
- The encryption key is required in production. Keep it in a secret manager: losing it makes encrypted identifiers unreadable.
- Run behind HTTPS (nginx, Caddy or a cloud load balancer). HSTS is sent in production.
- Copy the backup directory to off-site storage. Restore by stopping the service and replacing the database file with a backup.
- For large multi-hospital deployments, move to PostgreSQL. The schema is plain relational SQL, and all data access goes through `server/db.js` and the services.
- Follow the data-protection rules that apply where you deploy, such as India's DPDP Act 2023 and ABDM guidelines. Examples include consent capture, retention periods, and access reviews of the audit log.

## Known limitations & next steps

- **Module password layer:** the optional second password per module is not implemented; access is controlled by roles, per-user overrides and module switches.
- **Messaging providers:** SMS / WhatsApp / Email / Push adapters log messages instead of sending them. Plug in a provider in `server/lib/channels.js`.
- **Deep Assist is rule-based:** it maps questions onto the report catalogue and summarises from structured records. No external LLM is called.
- **PDF export** uses the browser's print-to-PDF on dedicated print layouts. There is no server-side PDF rendering.
- **ID proof** is stored as an encrypted number. There is no scanned-image upload. Employee documents are uploaded and stored encrypted.
- **Accounts module:** there is no general ledger or double-entry accounting. Finance runs on billing, collections and the revenue reports.
- **Branches:** the data model exists, with a main branch per hospital, but there is no branch-level UI yet.
- **Frontend tests:** there is no automated UI test suite; the headless-browser checks above were run manually during development.
