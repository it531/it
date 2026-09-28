-- Deep Hospital — relational schema (SQLite dialect; portable to PostgreSQL).
-- Every hospital-scoped table carries hospital_id and every query in the API is
-- filtered by the hospital bound to the authenticated session.

PRAGMA foreign_keys = ON;

-- ───────────────────────── Platform / tenancy ─────────────────────────
CREATE TABLE IF NOT EXISTS hospitals (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  legal_name TEXT,
  address TEXT, city TEXT, state TEXT, pincode TEXT,
  phone TEXT, email TEXT, website TEXT, gstin TEXT, registration_no TEXT,
  logo TEXT,                       -- data URL or path
  brand_color TEXT DEFAULT '#1463FF',
  plan TEXT NOT NULL DEFAULT 'standard',
  subscription_status TEXT NOT NULL DEFAULT 'active',  -- trial | active | past_due | cancelled
  subscription_expires_on TEXT,
  max_users INTEGER DEFAULT 100,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_activity_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  name TEXT NOT NULL, address TEXT, phone TEXT,
  is_main INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_branches_h ON branches(hospital_id);

CREATE TABLE IF NOT EXISTS hospital_modules (
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  module TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT,
  PRIMARY KEY (hospital_id, module)
);

CREATE TABLE IF NOT EXISTS settings (
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (hospital_id, key)
);

-- Server-side number sequences (UHID, IPD, tokens, invoices …). Never reused.
CREATE TABLE IF NOT EXISTS sequences (
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hospital_id, key)
);

-- ───────────────────────── Identity & access ─────────────────────────
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  dashboard TEXT NOT NULL DEFAULT 'admin',      -- which personalised dashboard
  created_at TEXT NOT NULL,
  UNIQUE (hospital_id, key)
);

CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY,
  module TEXT NOT NULL,
  action TEXT NOT NULL,
  UNIQUE (module, action)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER REFERENCES hospitals(id) ON DELETE CASCADE,   -- NULL = platform super admin
  username TEXT NOT NULL COLLATE NOCASE,
  full_name TEXT NOT NULL,
  email TEXT, phone TEXT,
  password_hash TEXT NOT NULL,
  is_super_admin INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  uses_demo_password INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_h_username ON users(IFNULL(hospital_id, 0), username);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- Per-user module overrides on top of role permissions: allow=1 grants view-level
-- (and listed actions), allow=0 blocks the module entirely for that user.
CREATE TABLE IF NOT EXISTS user_module_access (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module TEXT NOT NULL,
  allow INTEGER NOT NULL,
  actions TEXT,                       -- comma list when allow=1 (default 'view')
  PRIMARY KEY (user_id, module)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'staff',            -- staff | patient
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  patient_account_id INTEGER REFERENCES patient_accounts(id) ON DELETE CASCADE,
  hospital_id INTEGER REFERENCES hospitals(id) ON DELETE CASCADE,
  ip TEXT, user_agent TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

-- ───────────────────────── Masters ─────────────────────────
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  name TEXT NOT NULL, code TEXT, kind TEXT NOT NULL DEFAULT 'clinical', -- clinical | support | admin
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (hospital_id, name)
);

CREATE TABLE IF NOT EXISTS doctors (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  department_id INTEGER REFERENCES departments(id),
  name TEXT NOT NULL,
  specialization TEXT, qualification TEXT, registration_no TEXT,
  phone TEXT, email TEXT, room TEXT,
  consultation_fee REAL NOT NULL DEFAULT 0,
  followup_fee REAL NOT NULL DEFAULT 0,
  token_prefix TEXT NOT NULL DEFAULT 'A',
  avg_consult_minutes INTEGER NOT NULL DEFAULT 10,
  photo TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_doctors_h ON doctors(hospital_id);

-- ───────────────────────── Patients ─────────────────────────
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  uhid TEXT NOT NULL,
  uhid_seq INTEGER NOT NULL,
  first_name TEXT NOT NULL, last_name TEXT,
  full_name TEXT NOT NULL,
  dob TEXT, gender TEXT NOT NULL,
  mobile TEXT NOT NULL, alt_mobile TEXT, email TEXT,
  address TEXT, city TEXT, state TEXT, pincode TEXT,
  blood_group TEXT,
  emergency_name TEXT, emergency_relation TEXT, emergency_phone TEXT,
  occupation TEXT, marital_status TEXT,
  guardian_name TEXT, guardian_relation TEXT, guardian_phone TEXT,
  allergies TEXT, chronic_conditions TEXT,
  photo TEXT,
  insurance_provider TEXT, insurance_policy_no TEXT, insurance_valid_till TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE (hospital_id, uhid),
  UNIQUE (hospital_id, uhid_seq)
);
CREATE INDEX IF NOT EXISTS ix_patients_h_name ON patients(hospital_id, full_name);
CREATE INDEX IF NOT EXISTS ix_patients_h_mobile ON patients(hospital_id, mobile);
CREATE INDEX IF NOT EXISTS ix_patients_h_dob ON patients(hospital_id, dob);

-- Government / other IDs. Value is AES-256-GCM encrypted; blind_index (HMAC) enables exact search.
CREATE TABLE IF NOT EXISTS patient_identifiers (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  id_type TEXT NOT NULL,           -- aadhaar | pan | passport | voter | driving | abha | other
  value_enc TEXT NOT NULL,
  last4 TEXT,
  blind_index TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pid_blind ON patient_identifiers(hospital_id, blind_index);

CREATE TABLE IF NOT EXISTS patient_accounts (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL UNIQUE REFERENCES patients(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

-- ───────────────────────── Appointments & OPD ─────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  appt_no TEXT NOT NULL,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id INTEGER NOT NULL REFERENCES doctors(id),
  department_id INTEGER REFERENCES departments(id),
  scheduled_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 15,
  status TEXT NOT NULL DEFAULT 'booked', -- booked|confirmed|arrived|waiting|in_consultation|completed|cancelled|no_show
  source TEXT NOT NULL DEFAULT 'reception', -- reception|doctor|portal|api
  reason TEXT,
  visit_id INTEGER,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (hospital_id, appt_no)
);
CREATE INDEX IF NOT EXISTS ix_appt_h_time ON appointments(hospital_id, scheduled_at);
CREATE INDEX IF NOT EXISTS ix_appt_patient ON appointments(patient_id);

CREATE TABLE IF NOT EXISTS opd_visits (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  visit_no TEXT NOT NULL,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id INTEGER NOT NULL REFERENCES doctors(id),
  department_id INTEGER REFERENCES departments(id),
  appointment_id INTEGER REFERENCES appointments(id),
  visit_type TEXT NOT NULL DEFAULT 'new',  -- new | followup | emergency
  is_new_patient INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,     -- emergency = 10
  status TEXT NOT NULL DEFAULT 'waiting',  -- waiting|in_consultation|completed|cancelled|no_show
  visit_date TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  called_at TEXT, completed_at TEXT,
  chief_complaint TEXT,
  history_notes TEXT,
  clinical_notes TEXT,
  examination TEXT,
  advice TEXT,
  follow_up_date TEXT,
  followup_reminder_sent INTEGER NOT NULL DEFAULT 0,
  vitals TEXT,                              -- JSON {bp_sys,bp_dia,pulse,temp,spo2,weight,height,bmi,rr}
  draft_saved_at TEXT,
  created_by INTEGER REFERENCES users(id),
  UNIQUE (hospital_id, visit_no)
);
CREATE INDEX IF NOT EXISTS ix_visit_h_date ON opd_visits(hospital_id, visit_date);
CREATE INDEX IF NOT EXISTS ix_visit_patient ON opd_visits(patient_id);
CREATE INDEX IF NOT EXISTS ix_visit_doctor ON opd_visits(doctor_id, visit_date);

CREATE TABLE IF NOT EXISTS opd_tokens (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  visit_id INTEGER NOT NULL UNIQUE REFERENCES opd_visits(id) ON DELETE CASCADE,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id),
  token_date TEXT NOT NULL,
  token_seq INTEGER NOT NULL,
  token TEXT NOT NULL,
  UNIQUE (hospital_id, doctor_id, token_date, token_seq)
);

-- ───────────────────────── Diagnosis ─────────────────────────
CREATE TABLE IF NOT EXISTS diagnosis_codes (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  code TEXT,                      -- ICD-10 code
  name TEXT NOT NULL,
  specialty TEXT,
  synonyms TEXT,
  is_common INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (hospital_id, name)
);

CREATE TABLE IF NOT EXISTS visit_diagnoses (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  visit_id INTEGER REFERENCES opd_visits(id) ON DELETE CASCADE,
  admission_id INTEGER REFERENCES ipd_admissions(id) ON DELETE CASCADE,
  diagnosis_id INTEGER NOT NULL REFERENCES diagnosis_codes(id),
  doctor_id INTEGER REFERENCES doctors(id),
  kind TEXT NOT NULL DEFAULT 'provisional',  -- provisional | final
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_vdx_visit ON visit_diagnoses(visit_id);
CREATE INDEX IF NOT EXISTS ix_vdx_doctor ON visit_diagnoses(doctor_id, diagnosis_id);

CREATE TABLE IF NOT EXISTS doctor_favourite_diagnoses (
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  diagnosis_id INTEGER NOT NULL REFERENCES diagnosis_codes(id) ON DELETE CASCADE,
  PRIMARY KEY (doctor_id, diagnosis_id)
);

-- ───────────────────────── Medicines & prescriptions ─────────────────────────
CREATE TABLE IF NOT EXISTS medicines (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  name TEXT NOT NULL, generic_name TEXT, brand TEXT, strength TEXT,
  dosage_form TEXT, manufacturer TEXT, category TEXT, hsn TEXT,
  gst_rate REAL NOT NULL DEFAULT 12,
  purchase_price REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  supplier_id INTEGER REFERENCES suppliers(id),
  storage TEXT,
  default_route TEXT DEFAULT 'Oral',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (hospital_id, name, strength)
);
CREATE INDEX IF NOT EXISTS ix_med_h_name ON medicines(hospital_id, name);

CREATE TABLE IF NOT EXISTS medicine_batches (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_no TEXT NOT NULL,
  expiry_date TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  purchase_price REAL, mrp REAL,
  supplier_id INTEGER REFERENCES suppliers(id),
  received_at TEXT NOT NULL,
  UNIQUE (medicine_id, batch_no)
);
CREATE INDEX IF NOT EXISTS ix_batch_med ON medicine_batches(medicine_id, expiry_date);

CREATE TABLE IF NOT EXISTS doctor_favourite_medicines (
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  PRIMARY KEY (doctor_id, medicine_id)
);

-- Hospital-approved clinical templates. Suggestions only: never auto-applied.
CREATE TABLE IF NOT EXISTS prescription_templates (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  diagnosis_id INTEGER REFERENCES diagnosis_codes(id) ON DELETE SET NULL,
  advice TEXT,
  is_approved INTEGER NOT NULL DEFAULT 0,
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prescription_template_items (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES prescription_templates(id) ON DELETE CASCADE,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  dose TEXT, frequency TEXT, duration_days INTEGER, route TEXT, instructions TEXT
);

CREATE TABLE IF NOT EXISTS prescriptions (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  rx_no TEXT,
  visit_id INTEGER REFERENCES opd_visits(id) ON DELETE CASCADE,
  admission_id INTEGER REFERENCES ipd_admissions(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id INTEGER NOT NULL REFERENCES doctors(id),
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | finalized | cancelled
  notes TEXT,
  template_id INTEGER REFERENCES prescription_templates(id),
  finalized_at TEXT, finalized_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_rx_patient ON prescriptions(patient_id);
CREATE INDEX IF NOT EXISTS ix_rx_visit ON prescriptions(visit_id);

CREATE TABLE IF NOT EXISTS prescription_items (
  id INTEGER PRIMARY KEY,
  prescription_id INTEGER NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  dose TEXT, frequency TEXT, duration_days INTEGER, route TEXT, instructions TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  confirmed INTEGER NOT NULL DEFAULT 0,   -- doctor explicitly reviewed this line
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ───────────────────────── Pharmacy ─────────────────────────
CREATE TABLE IF NOT EXISTS pharmacy_orders (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  order_no TEXT NOT NULL,
  prescription_id INTEGER REFERENCES prescriptions(id),
  patient_id INTEGER REFERENCES patients(id),
  doctor_id INTEGER REFERENCES doctors(id),
  customer_name TEXT,                    -- walk-in counter sale
  status TEXT NOT NULL DEFAULT 'waiting', -- waiting|processing|ready|dispensed|cancelled
  source TEXT NOT NULL DEFAULT 'opd',     -- opd | ipd | counter
  invoice_id INTEGER REFERENCES invoices(id),
  created_at TEXT NOT NULL,
  called_at TEXT, ready_at TEXT, dispensed_at TEXT,
  dispensed_by INTEGER REFERENCES users(id),
  UNIQUE (hospital_id, order_no)
);
CREATE INDEX IF NOT EXISTS ix_pho_h_status ON pharmacy_orders(hospital_id, status);

CREATE TABLE IF NOT EXISTS pharmacy_order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES pharmacy_orders(id) ON DELETE CASCADE,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  quantity INTEGER NOT NULL,
  dispensed_qty INTEGER NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0,
  dose TEXT, frequency TEXT, duration_days INTEGER, instructions TEXT
);

CREATE TABLE IF NOT EXISTS pharmacy_tokens (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL UNIQUE REFERENCES pharmacy_orders(id) ON DELETE CASCADE,
  token_date TEXT NOT NULL,
  token_seq INTEGER NOT NULL,
  token TEXT NOT NULL,
  UNIQUE (hospital_id, token_date, token_seq)
);

-- ───────────────────────── Inventory ─────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  name TEXT NOT NULL, contact_person TEXT, phone TEXT, email TEXT, address TEXT, gstin TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  code TEXT, name TEXT NOT NULL,
  category TEXT NOT NULL,          -- equipment | consumable | surgical | general
  unit TEXT DEFAULT 'pcs',
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  min_stock INTEGER NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  location TEXT DEFAULT 'Main Store',
  supplier_id INTEGER REFERENCES suppliers(id),
  expiry_date TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,          -- medicine | item
  medicine_id INTEGER REFERENCES medicines(id),
  batch_id INTEGER REFERENCES medicine_batches(id),
  item_id INTEGER REFERENCES inventory_items(id),
  qty INTEGER NOT NULL,             -- +in / -out
  movement TEXT NOT NULL,           -- grn | dispense | issue | transfer | adjustment | return | opening
  ref_type TEXT, ref_id INTEGER,
  to_department_id INTEGER REFERENCES departments(id),
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sm_h ON stock_movements(hospital_id, created_at);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  po_no TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'ordered',   -- draft | ordered | received | cancelled
  total REAL NOT NULL DEFAULT 0,
  notes TEXT,
  grn_no TEXT, received_at TEXT, received_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (hospital_id, po_no)
);
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,          -- medicine | item
  medicine_id INTEGER REFERENCES medicines(id),
  item_id INTEGER REFERENCES inventory_items(id),
  quantity INTEGER NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  batch_no TEXT, expiry_date TEXT, mrp REAL
);

-- ───────────────────────── IPD ─────────────────────────
CREATE TABLE IF NOT EXISTS wards (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ward_type TEXT NOT NULL DEFAULT 'general',  -- general | semi_private | private | icu | nicu | emergency
  floor TEXT,
  daily_rate REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (hospital_id, name)
);

CREATE TABLE IF NOT EXISTS beds (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  ward_id INTEGER NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
  bed_no TEXT NOT NULL,
  room TEXT,
  status TEXT NOT NULL DEFAULT 'available',  -- available | occupied | reserved | cleaning | maintenance
  current_admission_id INTEGER,
  updated_at TEXT,
  UNIQUE (ward_id, bed_no)
);

CREATE TABLE IF NOT EXISTS ipd_admissions (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  ipd_no TEXT NOT NULL,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id INTEGER NOT NULL REFERENCES doctors(id),
  department_id INTEGER REFERENCES departments(id),
  bed_id INTEGER REFERENCES beds(id),
  nurse_user_id INTEGER REFERENCES users(id),
  visit_id INTEGER REFERENCES opd_visits(id),
  admission_type TEXT NOT NULL DEFAULT 'planned',  -- planned | emergency | transfer
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'admitted',         -- admitted | discharged | cancelled
  admitted_at TEXT NOT NULL,
  expected_discharge TEXT,
  discharged_at TEXT,
  discharge_type TEXT,                             -- normal | lama | referred | death
  final_diagnosis TEXT, discharge_summary TEXT, discharge_advice TEXT, follow_up_date TEXT,
  invoice_id INTEGER REFERENCES invoices(id),
  created_by INTEGER REFERENCES users(id),
  UNIQUE (hospital_id, ipd_no)
);
CREATE INDEX IF NOT EXISTS ix_ipd_h_status ON ipd_admissions(hospital_id, status);

CREATE TABLE IF NOT EXISTS ipd_notes (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id INTEGER NOT NULL REFERENCES ipd_admissions(id) ON DELETE CASCADE,
  note_type TEXT NOT NULL,     -- round | progress | instruction | procedure | nursing | handover
  body TEXT NOT NULL,
  acknowledged_by INTEGER REFERENCES users(id), acknowledged_at TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ipd_charges (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id INTEGER NOT NULL REFERENCES ipd_admissions(id) ON DELETE CASCADE,
  category TEXT NOT NULL,      -- procedure | consultation | consumable | lab | radiology | pharmacy | other
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id)
);

-- Medication orders for IPD (MAR) and each administration.
CREATE TABLE IF NOT EXISTS ipd_medications (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id INTEGER NOT NULL REFERENCES ipd_admissions(id) ON DELETE CASCADE,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  dose TEXT, route TEXT, frequency TEXT,
  times TEXT,                 -- comma list of HH:MM
  start_date TEXT NOT NULL, end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active | stopped
  ordered_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS medication_administrations (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  medication_id INTEGER NOT NULL REFERENCES ipd_medications(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'given',   -- given | held | refused
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (medication_id, scheduled_for)
);

CREATE TABLE IF NOT EXISTS nursing_records (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id INTEGER NOT NULL REFERENCES ipd_admissions(id) ON DELETE CASCADE,
  bp_sys INTEGER, bp_dia INTEGER, pulse INTEGER, temp REAL, spo2 INTEGER,
  rr INTEGER, blood_sugar INTEGER, pain_score INTEGER,
  intake_ml INTEGER, output_ml INTEGER,
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_nr_adm ON nursing_records(admission_id, recorded_at);

-- ───────────────────────── Laboratory ─────────────────────────
CREATE TABLE IF NOT EXISTS lab_tests (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  code TEXT, name TEXT NOT NULL, category TEXT, sample_type TEXT,
  price REAL NOT NULL DEFAULT 0,
  tat_hours INTEGER DEFAULT 24,
  parameters TEXT,             -- JSON [{name, unit, ref_low, ref_high, ref_text}]
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (hospital_id, name)
);

CREATE TABLE IF NOT EXISTS lab_orders (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  order_no TEXT NOT NULL,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  test_id INTEGER NOT NULL REFERENCES lab_tests(id),
  visit_id INTEGER REFERENCES opd_visits(id),
  admission_id INTEGER REFERENCES ipd_admissions(id),
  doctor_id INTEGER REFERENCES doctors(id),
  priority TEXT NOT NULL DEFAULT 'routine',  -- routine | urgent | stat
  status TEXT NOT NULL DEFAULT 'ordered',    -- ordered|sample_collected|processing|completed|verified|cancelled
  sample_id TEXT,
  collected_at TEXT, collected_by INTEGER REFERENCES users(id),
  technician_id INTEGER REFERENCES users(id),
  completed_at TEXT,
  verified_at TEXT, verified_by INTEGER REFERENCES users(id),
  invoice_id INTEGER REFERENCES invoices(id),
  price REAL NOT NULL DEFAULT 0,
  remarks TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (hospital_id, order_no)
);
CREATE INDEX IF NOT EXISTS ix_lab_h_status ON lab_orders(hospital_id, status);
CREATE INDEX IF NOT EXISTS ix_lab_patient ON lab_orders(patient_id);

CREATE TABLE IF NOT EXISTS lab_results (
  id INTEGER PRIMARY KEY,
  lab_order_id INTEGER NOT NULL REFERENCES lab_orders(id) ON DELETE CASCADE,
  parameter TEXT NOT NULL,
  value TEXT,
  unit TEXT, ref_range TEXT,
  flag TEXT                     -- L | H | N | C
);

-- ───────────────────────── Radiology ─────────────────────────
CREATE TABLE IF NOT EXISTS radiology_orders (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  order_no TEXT NOT NULL,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id INTEGER REFERENCES doctors(id),
  visit_id INTEGER REFERENCES opd_visits(id),
  admission_id INTEGER REFERENCES ipd_admissions(id),
  modality TEXT NOT NULL,       -- X-Ray | CT | MRI | Ultrasound | Other
  study TEXT NOT NULL,
  clinical_info TEXT,
  status TEXT NOT NULL DEFAULT 'ordered',   -- ordered|scheduled|scanned|reported|verified|cancelled
  scheduled_at TEXT, scanned_at TEXT,
  price REAL NOT NULL DEFAULT 0,
  invoice_id INTEGER REFERENCES invoices(id),
  created_at TEXT NOT NULL,
  UNIQUE (hospital_id, order_no)
);
CREATE TABLE IF NOT EXISTS radiology_reports (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES radiology_orders(id) ON DELETE CASCADE,
  findings TEXT, impression TEXT,
  reported_by INTEGER REFERENCES users(id), reported_at TEXT,
  verified_by INTEGER REFERENCES users(id), verified_at TEXT
);

-- ───────────────────────── Billing ─────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  invoice_no TEXT NOT NULL,
  patient_id INTEGER REFERENCES patients(id),
  customer_name TEXT,
  bill_type TEXT NOT NULL,       -- opd|ipd|pharmacy|laboratory|radiology|procedure|package|other
  visit_id INTEGER REFERENCES opd_visits(id),
  admission_id INTEGER REFERENCES ipd_admissions(id),
  doctor_id INTEGER REFERENCES doctors(id),
  department_id INTEGER REFERENCES departments(id),
  subtotal REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  paid REAL NOT NULL DEFAULT 0,
  refunded REAL NOT NULL DEFAULT 0,
  balance REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid',  -- draft|unpaid|partial|paid|refunded|cancelled
  insurance_claim_amount REAL DEFAULT 0,
  insurance_claim_status TEXT,            -- none|submitted|approved|rejected|settled
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (hospital_id, invoice_no)
);
CREATE INDEX IF NOT EXISTS ix_inv_h_date ON invoices(hospital_id, created_at);
CREATE INDEX IF NOT EXISTS ix_inv_patient ON invoices(patient_id);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  ref_type TEXT, ref_id INTEGER
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  receipt_no TEXT NOT NULL,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  patient_id INTEGER REFERENCES patients(id),
  kind TEXT NOT NULL DEFAULT 'payment',   -- payment | refund
  amount REAL NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL,                   -- cash | upi | card | bank_transfer | other
  reference TEXT,
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (hospital_id, receipt_no)
);
CREATE INDEX IF NOT EXISTS ix_pay_h_date ON payments(hospital_id, created_at);

-- ───────────────────────── HR & payroll ─────────────────────────
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  emp_code TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  full_name TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  designation TEXT,
  employment_type TEXT DEFAULT 'full_time',
  joining_date TEXT,
  phone TEXT, email TEXT, address TEXT,
  emergency_contact TEXT,
  shift TEXT DEFAULT 'General (09:00-17:00)',
  bank_name TEXT, bank_account_enc TEXT, bank_account_last4 TEXT, ifsc TEXT,
  pan_enc TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active | on_notice | exited
  created_at TEXT NOT NULL,
  UNIQUE (hospital_id, emp_code)
);

CREATE TABLE IF NOT EXISTS employee_documents (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL, file_name TEXT NOT NULL, mime TEXT,
  content_enc TEXT NOT NULL,     -- encrypted base64 content
  size INTEGER,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  check_in TEXT, check_out TEXT,
  status TEXT NOT NULL,           -- present | absent | late | half_day | leave
  overtime_hours REAL NOT NULL DEFAULT 0,
  shift TEXT,
  note TEXT,
  UNIQUE (employee_id, date)
);
CREATE INDEX IF NOT EXISTS ix_att_h_date ON attendance(hospital_id, date);

CREATE TABLE IF NOT EXISTS leaves (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type TEXT NOT NULL,       -- casual | sick | earned | unpaid
  from_date TEXT NOT NULL, to_date TEXT NOT NULL,
  days REAL NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS salary_structures (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  basic REAL NOT NULL DEFAULT 0, hra REAL NOT NULL DEFAULT 0, allowances REAL NOT NULL DEFAULT 0,
  bonus REAL NOT NULL DEFAULT 0, overtime_rate REAL NOT NULL DEFAULT 0,
  pf_percent REAL NOT NULL DEFAULT 12, esi_percent REAL NOT NULL DEFAULT 0.75,
  professional_tax REAL NOT NULL DEFAULT 200, other_deductions REAL NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS payroll (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month TEXT NOT NULL,            -- YYYY-MM
  working_days INTEGER NOT NULL, paid_days REAL NOT NULL, lop_days REAL NOT NULL DEFAULT 0,
  basic REAL, hra REAL, allowances REAL, bonus REAL, overtime REAL,
  gross REAL NOT NULL,
  pf REAL, esi REAL, professional_tax REAL, other_deductions REAL, lop_deduction REAL,
  total_deductions REAL NOT NULL,
  net_pay REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'processed',  -- processed | paid
  created_at TEXT NOT NULL,
  UNIQUE (employee_id, month)
);

-- ───────────────────────── Notifications ─────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER REFERENCES hospitals(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,       -- direct to user
  audience_module TEXT,                                          -- or everyone with view on this module
  patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,  -- or a patient (portal)
  category TEXT NOT NULL,         -- appointment | opd | pharmacy | inventory | lab | radiology | billing | ipd | report | system
  severity TEXT NOT NULL DEFAULT 'info',  -- info | success | warning | critical
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  dedupe_key TEXT,
  read_at TEXT,                   -- for user/patient notifications
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notif_h ON notifications(hospital_id, created_at);
CREATE INDEX IF NOT EXISTS ix_notif_patient ON notifications(patient_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notif_dedupe ON notifications(hospital_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL,
  PRIMARY KEY (notification_id, user_id)
);

-- Outbound channel queue (SMS / WhatsApp / Email / Push). Providers plug into server/lib/channels.js.
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER REFERENCES hospitals(id) ON DELETE CASCADE,
  notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',    -- queued | sent | failed | skipped
  provider TEXT, provider_ref TEXT, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_nd_status ON notification_deliveries(status);

-- ───────────────────────── Reports, audit, backup ─────────────────────────
CREATE TABLE IF NOT EXISTS saved_reports (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  report_type TEXT NOT NULL,
  filters TEXT NOT NULL,           -- JSON
  schedule TEXT,                   -- none | daily | weekly | monthly
  last_run_at TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER REFERENCES hospitals(id) ON DELETE CASCADE,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  entity TEXT, entity_id INTEGER, ref TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_h ON audit_logs(hospital_id, created_at);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY,
  file_name TEXT NOT NULL,
  size_bytes INTEGER,
  status TEXT NOT NULL,            -- success | failed
  trigger TEXT NOT NULL,           -- scheduled | manual
  error TEXT,
  created_at TEXT NOT NULL
);
