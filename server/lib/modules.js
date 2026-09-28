'use strict';
// Single source of truth for modules, actions and default role templates.

const MODULES = [
  { key: 'dashboard', name: 'Dashboard', core: true },
  { key: 'patients', name: 'Patients', core: true },
  { key: 'reception', name: 'Reception' },
  { key: 'appointments', name: 'Appointments' },
  { key: 'opd', name: 'OPD' },
  { key: 'doctor', name: 'Doctor Consultation' },
  { key: 'emergency', name: 'Emergency' },
  { key: 'pharmacy', name: 'Pharmacy' },
  { key: 'inventory', name: 'Inventory' },
  { key: 'ipd', name: 'IPD' },
  { key: 'nursing', name: 'Nursing' },
  { key: 'laboratory', name: 'Laboratory' },
  { key: 'radiology', name: 'Radiology' },
  { key: 'billing', name: 'Billing' },
  { key: 'insurance', name: 'Insurance' },
  { key: 'accounts', name: 'Accounts' },
  { key: 'hr', name: 'HR & Employees' },
  { key: 'payroll', name: 'Payroll' },
  { key: 'mis', name: 'MIS & Analytics' },
  { key: 'reports', name: 'Reports' },
  { key: 'portal', name: 'Patient Portal' },
  { key: 'settings', name: 'Settings', core: true },
  { key: 'audit', name: 'Audit Log', core: true },
];
const MODULE_KEYS = MODULES.map((m) => m.key);
const ACTIONS = ['view', 'add', 'edit', 'delete', 'approve', 'export', 'print', 'download', 'report'];

const ALL = '*';
const V = ['view'];
const VA = ['view', 'add'];
const VAE = ['view', 'add', 'edit'];
const VAEP = ['view', 'add', 'edit', 'print'];
const FULL = ACTIONS;

// Default role templates created for every new hospital. Hospital admins can edit
// them or create custom roles from the permission matrix.
const ROLE_TEMPLATES = [
  { key: 'hospital_admin', name: 'Hospital Admin', dashboard: 'admin', description: 'Full access to the hospital', perms: ALL },
  { key: 'reception', name: 'Reception', dashboard: 'reception', description: 'Registration, appointments, OPD queue, collections',
    perms: { dashboard: V, patients: [...VAEP, 'export'], reception: FULL, appointments: [...VAEP, 'delete'], opd: VAEP, emergency: VAEP, billing: ['view', 'add', 'print'], laboratory: V, radiology: V, ipd: V, portal: VAE } },
  { key: 'doctor', name: 'Doctor', dashboard: 'doctor', description: 'OPD consultation, diagnosis, prescriptions, investigations',
    perms: { dashboard: V, patients: ['view', 'edit', 'print'], appointments: VAE, opd: VAEP, doctor: [...VAEP, 'approve'], emergency: VAEP, ipd: VAEP, nursing: V, laboratory: ['view', 'add', 'print'], radiology: ['view', 'add', 'print'], pharmacy: V, reports: ['view', 'report'] } },
  { key: 'nurse', name: 'Nurse', dashboard: 'nurse', description: 'IPD care, vitals, medication administration',
    perms: { dashboard: V, patients: V, ipd: VAE, nursing: FULL, emergency: VAE, laboratory: V, radiology: V, opd: V } },
  { key: 'pharmacist', name: 'Pharmacist', dashboard: 'pharmacist', description: 'Prescription queue, dispensing, stock',
    perms: { dashboard: V, patients: V, pharmacy: FULL, inventory: [...VAE, 'export', 'print'], billing: ['view', 'add', 'print'] } },
  { key: 'billing', name: 'Billing Executive', dashboard: 'billing', description: 'Invoices, payments, receipts, refunds',
    perms: { dashboard: V, patients: V, billing: [...VAEP, 'export', 'download'], insurance: VAE, opd: V, ipd: V, reports: ['view', 'report', 'export'] } },
  { key: 'lab_tech', name: 'Lab Technician', dashboard: 'lab', description: 'Sample collection, results, verification',
    perms: { dashboard: V, patients: V, laboratory: [...VAEP, 'approve'] } },
  { key: 'radiology_tech', name: 'Radiology Technician', dashboard: 'radiology', description: 'Scans and radiology reports',
    perms: { dashboard: V, patients: V, radiology: [...VAEP, 'approve'] } },
  { key: 'hr', name: 'HR', dashboard: 'hr', description: 'Employees, attendance, leave, payroll',
    perms: { dashboard: V, hr: FULL, payroll: FULL, reports: ['view', 'report', 'export'] } },
  { key: 'accounts', name: 'Accounts', dashboard: 'management', description: 'Financial reports and accounting',
    perms: { dashboard: V, billing: ['view', 'export', 'print', 'approve'], accounts: FULL, insurance: VAE, payroll: V, reports: ['view', 'report', 'export', 'download', 'print'], mis: V } },
  { key: 'management', name: 'Management', dashboard: 'management', description: 'MIS and management dashboards',
    perms: { dashboard: V, patients: V, opd: V, ipd: V, pharmacy: V, billing: V, hr: V, mis: FULL, reports: FULL, audit: V } },
];

function expandPerms(perms) {
  const out = [];
  if (perms === ALL) { for (const m of MODULE_KEYS) for (const a of ACTIONS) out.push([m, a]); return out; }
  for (const [m, acts] of Object.entries(perms)) for (const a of acts) out.push([m, a]);
  return out;
}

module.exports = { MODULES, MODULE_KEYS, ACTIONS, ROLE_TEMPLATES, expandPerms };
