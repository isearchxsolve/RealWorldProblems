/**
 * Post-hospitalization medical bill tracking domain module.
 *
 * Models the real-world problem tracked in muaddibco/RealWorldProblems#1434:
 * a patient discharged from a US hospital stay receives 4-8 separate bills from
 * independent providers (hospital, anesthesiologist, radiologist, attending
 * physician, lab) that arrive weeks apart and rarely state whether the insurer
 * has been billed, paid, partially covered or denied the claim. The patient has
 * no single place to answer "is this bill genuinely due now, or is it still
 * pending insurance adjudication?" and can either overpay before adjudication or
 * let a real due date lapse and be sent to collections.
 *
 * The module is deliberately framework-free (no Azure Functions runtime, no
 * network or storage I/O) so it can be unit tested and reused by the portal API
 * and by the orchestrator:
 *
 *  - strict, typed validation for every input; null, undefined, whitespace-only,
 *    malformed and out-of-range values are rejected with a `BillingError`
 *    carrying a stable `code` and an HTTP `status`;
 *  - a half-open insurance-adjudication window so a bill that is still `pending`
 *    is only treated as "safely awaiting insurance" while
 *    `elapsedDays < ADJUDICATION_WINDOW_DAYS`; at exactly the threshold the bill
 *    is escalated instead of silently presumed pending;
 *  - a half-open payment window between a bill being received and its due date;
 *  - atomic, single-writer transitions so a bill can never be paid twice (zero
 *    double spend) even when callers act concurrently.
 */

/** Maximum number of provider bills a single hospitalization episode may track. */
export const MAX_BILLS = 12;

/** Maximum value of a single provider bill, in cents ($1,000,000.00). */
export const MAX_BILL_AMOUNT_CENTS = 100_000_000;

/**
 * Number of days after a bill is received within which the insurer is expected
 * to adjudicate the associated claim.
 *
 * The window is half-open: a bill that is still `pending` is treated as safely
 * awaiting insurance while `elapsedDays < ADJUDICATION_WINDOW_DAYS`. At exactly
 * `ADJUDICATION_WINDOW_DAYS` the bill is no longer safely pending and must be
 * escalated (bill the insurer / call the provider) so the due date is not
 * missed and the account is not silently sent to collections.
 */
export const ADJUDICATION_WINDOW_DAYS = 21;

/**
 * Half-open upper bound, in days, for a bill's payment window
 * (`dueDay - receivedDay`). A window of `>= 0` and `< MAX_PAYMENT_WINDOW_DAYS`
 * is accepted; a window of exactly `MAX_PAYMENT_WINDOW_DAYS` is rejected.
 */
export const MAX_PAYMENT_WINDOW_DAYS = 365;

/** Inclusive upper bound, in days from discharge, for a tracking day value. */
export const MAX_TRACKING_DAY = 3650;

export type BillingErrorCode =
  | 'INVALID_INPUT'
  | 'MISSING_FIELD'
  | 'EMPTY_FIELD'
  | 'OUT_OF_RANGE'
  | 'DUPLICATE_ID'
  | 'UNKNOWN_BILL'
  | 'UNAUTHORIZED_ACTOR'
  | 'BILL_ALREADY_PAID'
  | 'BILL_NOT_DUE'
  | 'INSURANCE_ALREADY_ADJUDICATED'
  | 'TRACKING_NOT_FOUND';

/** Typed, stable error surfaced by every tracker operation. */
export class BillingError extends Error {
  readonly code: BillingErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: BillingErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    this.status = status;
    this.details = details;
    Object.setPrototypeOf(this, BillingError.prototype);
  }
}

export type InsuranceStatus = 'not-billed' | 'pending' | 'adjudicated' | 'denied';

export type BillStatus = 'paid' | 'submit-claim' | 'pending-insurance' | 'due' | 'escalate';

export type ProviderBill = {
  id: string;
  providerName: string;
  billedAmountCents: number;
  receivedDay: number;
  dueDay: number;
  insuranceStatus: InsuranceStatus;
  patientResponsibilityCents: number | null;
  paid: boolean;
};

export type BillingTracking = {
  trackingId: string;
  patientId: string;
  bills: ProviderBill[];
  createdAt: string;
};

export type TrackingSummary = {
  trackingId: string;
  billCount: number;
  billStatuses: Record<string, BillStatus>;
  paidBillIds: string[];
  paidTotalCents: number;
  outstandingTotalCents: number;
  pendingInsuranceBillIds: string[];
  escalatedBillIds: string[];
  billsNeedingActionIds: string[];
  nextActionableBillId: string | null;
};

export type PaymentReceipt = {
  trackingId: string;
  billId: string;
  providerName: string;
  amountCents: number;
  paidAt: string;
};

const INSURANCE_STATUSES: readonly InsuranceStatus[] = ['not-billed', 'pending', 'adjudicated', 'denied'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a required, non-blank string field. */
export function requireNonEmptyString(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    throw new BillingError('MISSING_FIELD', `Field '${field}' is required.`, 400, { field });
  }
  if (typeof value !== 'string') {
    throw new BillingError('INVALID_INPUT', `Field '${field}' must be a string.`, 400, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BillingError('EMPTY_FIELD', `Field '${field}' must not be empty or whitespace-only.`, 400, { field });
  }
  return trimmed;
}

/** Validates a required integer inside the inclusive range [min, max]. */
export function requireIntegerInRange(value: unknown, field: string, min: number, max: number): number {
  if (value === undefined || value === null) {
    throw new BillingError('MISSING_FIELD', `Field '${field}' is required.`, 400, { field });
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BillingError('INVALID_INPUT', `Field '${field}' must be an integer.`, 400, { field });
  }
  if (value < min || value > max) {
    throw new BillingError(
      'OUT_OF_RANGE',
      `Field '${field}' must be between ${min} and ${max} (received ${value}).`,
      400,
      { field, value, min, max }
    );
  }
  return value;
}

/** Resolves an optional insurance status, defaulting to `not-billed`. */
export function resolveInsuranceStatus(value: unknown): InsuranceStatus {
  if (value === undefined || value === null) {
    return 'not-billed';
  }
  if (typeof value !== 'string' || !INSURANCE_STATUSES.includes(value as InsuranceStatus)) {
    throw new BillingError(
      'INVALID_INPUT',
      `Field 'insuranceStatus' must be one of ${INSURANCE_STATUSES.join(', ')}.`,
      400,
      { value }
    );
  }
  return value as InsuranceStatus;
}

/**
 * Validates the patient responsibility for a bill against its billed amount and
 * insurance status. A bill that has been adjudicated must carry an explicit
 * patient responsibility in [0, billedAmountCents]; `denied` bills default to
 * the full billed amount; bills still being adjudicated must not carry one.
 */
function resolveResponsibility(
  billId: string,
  insuranceStatus: InsuranceStatus,
  billedAmountCents: number,
  rawValue: unknown
): number | null {
  if (insuranceStatus === 'adjudicated') {
    return requireIntegerInRange(rawValue, `bills[${billId}].patientResponsibilityCents`, 0, billedAmountCents);
  }
  if (insuranceStatus === 'denied') {
    if (rawValue === undefined || rawValue === null) {
      return billedAmountCents;
    }
    const provided = requireIntegerInRange(rawValue, `bills[${billId}].patientResponsibilityCents`, 0, billedAmountCents);
    if (provided !== billedAmountCents) {
      throw new BillingError(
        'INVALID_INPUT',
        `Denied bill '${billId}' must carry the full billed amount as patient responsibility.`,
        400,
        { billId, billedAmountCents, provided }
      );
    }
    return billedAmountCents;
  }
  if (rawValue === undefined || rawValue === null) {
    return null;
  }
  throw new BillingError(
    'INVALID_INPUT',
    `Bill '${billId}' cannot carry a patient responsibility before insurance adjudication.`,
    400,
    { billId, insuranceStatus }
  );
}

/**
 * Validates an untrusted payload and builds a brand new tracking aggregate.
 * Throws a typed `BillingError` for any null, empty, malformed or out-of-range
 * input; never returns a partially built tracking record.
 */
export function buildTracking(input: unknown): BillingTracking {
  if (input === undefined || input === null) {
    throw new BillingError('INVALID_INPUT', 'Tracking payload is required.', 400);
  }
  if (!isPlainObject(input)) {
    throw new BillingError('INVALID_INPUT', 'Tracking payload must be an object.', 400);
  }

  const trackingId = requireNonEmptyString(input.trackingId, 'trackingId');
  const patientId = requireNonEmptyString(input.patientId, 'patientId');

  const rawBills = input.bills;
  if (rawBills === undefined || rawBills === null) {
    throw new BillingError('MISSING_FIELD', "Field 'bills' is required.", 400, { field: 'bills' });
  }
  if (!Array.isArray(rawBills)) {
    throw new BillingError('INVALID_INPUT', "Field 'bills' must be an array.", 400, { field: 'bills' });
  }
  if (rawBills.length === 0) {
    throw new BillingError('EMPTY_FIELD', 'Tracking must include at least one bill.', 400, { field: 'bills' });
  }
  if (rawBills.length > MAX_BILLS) {
    throw new BillingError(
      'OUT_OF_RANGE',
      `Tracking may include at most ${MAX_BILLS} bills (received ${rawBills.length}).`,
      400,
      { field: 'bills', max: MAX_BILLS, received: rawBills.length }
    );
  }

  const bills: ProviderBill[] = [];
  const billIds = new Set<string>();
  const rawBillList = rawBills as unknown[];

  for (let index = 0; index < rawBillList.length; index += 1) {
    const raw = rawBillList[index];
    if (!isPlainObject(raw)) {
      throw new BillingError('INVALID_INPUT', `Bill at index ${index} must be an object.`, 400, { index });
    }
    const id = requireNonEmptyString(raw.id, `bills[${index}].id`);
    if (billIds.has(id)) {
      throw new BillingError('DUPLICATE_ID', `Duplicate bill id '${id}'.`, 409, { id });
    }
    billIds.add(id);

    const providerName = requireNonEmptyString(raw.providerName, `bills[${index}].providerName`);
    const billedAmountCents = requireIntegerInRange(raw.billedAmountCents, `bills[${index}].billedAmountCents`, 1, MAX_BILL_AMOUNT_CENTS);
    const receivedDay = requireIntegerInRange(raw.receivedDay, `bills[${index}].receivedDay`, 0, MAX_TRACKING_DAY);
    const dueDay = requireIntegerInRange(raw.dueDay, `bills[${index}].dueDay`, 0, MAX_TRACKING_DAY);
    if (dueDay < receivedDay) {
      throw new BillingError(
        'OUT_OF_RANGE',
        `Bill '${id}' dueDay must be greater than or equal to receivedDay.`,
        400,
        { id, receivedDay, dueDay }
      );
    }
    const paymentWindowDays = dueDay - receivedDay;
    if (paymentWindowDays >= MAX_PAYMENT_WINDOW_DAYS) {
      throw new BillingError(
        'OUT_OF_RANGE',
        `Bill '${id}' payment window is ${paymentWindowDays} days, exceeding the ${MAX_PAYMENT_WINDOW_DAYS}-day tracking window.`,
        400,
        { id, paymentWindowDays, maxPaymentWindowDays: MAX_PAYMENT_WINDOW_DAYS }
      );
    }

    const insuranceStatus = resolveInsuranceStatus(raw.insuranceStatus);
    const patientResponsibilityCents = resolveResponsibility(id, insuranceStatus, billedAmountCents, raw.patientResponsibilityCents);
    const paid = raw.paid === true;
    if (paid && insuranceStatus !== 'adjudicated' && insuranceStatus !== 'denied') {
      throw new BillingError(
        'INVALID_INPUT',
        `Bill '${id}' cannot be marked paid before insurance adjudication.`,
        400,
        { id, insuranceStatus }
      );
    }

    bills.push({
      id,
      providerName,
      billedAmountCents,
      receivedDay,
      dueDay,
      insuranceStatus,
      patientResponsibilityCents,
      paid
    });
  }

  return {
    trackingId,
    patientId,
    bills,
    createdAt: new Date().toISOString()
  };
}

function cloneTracking(tracking: BillingTracking): BillingTracking {
  return {
    trackingId: tracking.trackingId,
    patientId: tracking.patientId,
    createdAt: tracking.createdAt,
    bills: tracking.bills.map((bill) => ({ ...bill }))
  };
}

/**
 * Classifies a single bill relative to an "as-of" day, answering the core
 * question of the issue: is this bill genuinely due now, still pending insurance
 * adjudication, or does it need the patient to act before the due date?
 *
 * The adjudication window is half-open: a `pending` bill stays
 * `pending-insurance` while `asOfDay - receivedDay < ADJUDICATION_WINDOW_DAYS`
 * and is escalated once the elapsed time reaches the window.
 */
export function classifyBill(bill: ProviderBill, asOfDay: number): BillStatus {
  const asOf = requireIntegerInRange(asOfDay, 'asOfDay', 0, MAX_TRACKING_DAY);
  if (bill.paid) {
    return 'paid';
  }
  switch (bill.insuranceStatus) {
    case 'not-billed':
      return 'submit-claim';
    case 'adjudicated':
    case 'denied':
      return 'due';
    case 'pending': {
      const elapsedDays = asOf - bill.receivedDay;
      return elapsedDays < ADJUDICATION_WINDOW_DAYS ? 'pending-insurance' : 'escalate';
    }
    default:
      return 'submit-claim';
  }
}

/**
 * Records an insurer decision for a bill: either `adjudicated` (with the agreed
 * patient responsibility) or `denied` (full billed amount becomes patient
 * responsibility). Only the tracked patient may mutate their own bills.
 */
export function applyInsuranceDecision(tracking: BillingTracking, input: unknown): BillingTracking {
  if (!isPlainObject(input)) {
    throw new BillingError('INVALID_INPUT', 'Insurance decision payload must be an object.', 400);
  }
  const billId = requireNonEmptyString(input.billId, 'billId');
  const actorId = requireNonEmptyString(input.actorId, 'actorId');
  if (actorId !== tracking.patientId) {
    throw new BillingError(
      'UNAUTHORIZED_ACTOR',
      `Actor '${actorId}' is not authorized to record decisions for tracking '${tracking.trackingId}'.`,
      403,
      { actorId }
    );
  }
  const decision = input.insuranceStatus;
  if (decision !== 'adjudicated' && decision !== 'denied') {
    throw new BillingError(
      'INVALID_INPUT',
      "Field 'insuranceStatus' must be 'adjudicated' or 'denied'.",
      400,
      { decision }
    );
  }

  const next = cloneTracking(tracking);
  const bill = next.bills.find((entry) => entry.id === billId);
  if (!bill) {
    throw new BillingError('UNKNOWN_BILL', `Unknown bill '${billId}'.`, 404, { billId });
  }
  if (bill.insuranceStatus === 'adjudicated' || bill.insuranceStatus === 'denied') {
    throw new BillingError(
      'INSURANCE_ALREADY_ADJUDICATED',
      `Bill '${billId}' has already been adjudicated by the insurer.`,
      409,
      { billId, insuranceStatus: bill.insuranceStatus }
    );
  }

  bill.insuranceStatus = decision;
  bill.patientResponsibilityCents = resolveResponsibility(
    bill.id,
    decision,
    bill.billedAmountCents,
    input.patientResponsibilityCents
  );
  return next;
}

/**
 * Pays a bill exactly once. A bill can only be paid once the insurer has
 * adjudicated (or denied) the claim and the patient actually owes a balance, so
 * a patient can never overpay a bill that is still pending insurance.
 */
export function applyPayment(
  tracking: BillingTracking,
  input: unknown
): { tracking: BillingTracking; receipt: PaymentReceipt } {
  if (!isPlainObject(input)) {
    throw new BillingError('INVALID_INPUT', 'Payment payload must be an object.', 400);
  }
  const billId = requireNonEmptyString(input.billId, 'billId');
  const actorId = requireNonEmptyString(input.actorId, 'actorId');
  if (actorId !== tracking.patientId) {
    throw new BillingError(
      'UNAUTHORIZED_ACTOR',
      `Actor '${actorId}' is not authorized to pay bills for tracking '${tracking.trackingId}'.`,
      403,
      { actorId }
    );
  }

  const next = cloneTracking(tracking);
  const bill = next.bills.find((entry) => entry.id === billId);
  if (!bill) {
    throw new BillingError('UNKNOWN_BILL', `Unknown bill '${billId}'.`, 404, { billId });
  }
  if (bill.paid) {
    throw new BillingError('BILL_ALREADY_PAID', `Bill '${billId}' has already been paid.`, 409, { billId });
  }
  if (bill.insuranceStatus !== 'adjudicated' && bill.insuranceStatus !== 'denied') {
    throw new BillingError(
      'BILL_NOT_DUE',
      `Bill '${billId}' is still pending insurance adjudication and must not be paid yet.`,
      409,
      { billId, insuranceStatus: bill.insuranceStatus }
    );
  }
  const amountCents = bill.patientResponsibilityCents ?? bill.billedAmountCents;
  if (amountCents <= 0) {
    throw new BillingError(
      'OUT_OF_RANGE',
      `Bill '${billId}' has no patient balance due and must not be paid.`,
      400,
      { billId, amountCents }
    );
  }

  bill.paid = true;
  const receipt: PaymentReceipt = {
    trackingId: next.trackingId,
    billId: bill.id,
    providerName: bill.providerName,
    amountCents,
    paidAt: new Date().toISOString()
  };
  return { tracking: next, receipt };
}

/** Builds the patient-facing view of which bills are due versus pending. */
export function summarizeTracking(tracking: BillingTracking, asOfDay: number): TrackingSummary {
  const asOf = requireIntegerInRange(asOfDay, 'asOfDay', 0, MAX_TRACKING_DAY);
  const billStatuses: Record<string, BillStatus> = {};
  const paidBillIds: string[] = [];
  const pendingInsuranceBillIds: string[] = [];
  const escalatedBillIds: string[] = [];
  const billsNeedingActionIds: string[] = [];
  const needingAction: ProviderBill[] = [];
  let paidTotalCents = 0;
  let outstandingTotalCents = 0;

  for (const bill of tracking.bills) {
    const status = classifyBill(bill, asOf);
    billStatuses[bill.id] = status;
    if (status === 'paid') {
      paidBillIds.push(bill.id);
      paidTotalCents += bill.patientResponsibilityCents ?? 0;
      continue;
    }
    if (status === 'pending-insurance') {
      pendingInsuranceBillIds.push(bill.id);
      continue;
    }
    if (status === 'escalate') {
      escalatedBillIds.push(bill.id);
    }
    if (status === 'due') {
      outstandingTotalCents += bill.patientResponsibilityCents ?? 0;
    }
    billsNeedingActionIds.push(bill.id);
    needingAction.push(bill);
  }

  const nextActionable = needingAction
    .slice()
    .sort((a, b) => a.dueDay - b.dueDay || a.id.localeCompare(b.id))[0];

  return {
    trackingId: tracking.trackingId,
    billCount: tracking.bills.length,
    billStatuses,
    paidBillIds,
    paidTotalCents,
    outstandingTotalCents,
    pendingInsuranceBillIds,
    escalatedBillIds,
    billsNeedingActionIds,
    nextActionableBillId: nextActionable ? nextActionable.id : null
  };
}

/**
 * In-memory, single-writer tracker.
 *
 * Every mutation is serialized per tracking record with a lightweight promise
 * mutex, so two concurrent requests against the same bill result in exactly one
 * payment and a safe rejection for the loser (no double spend).
 */
export class MedicalBillTracker {
  private readonly trackings = new Map<string, BillingTracking>();
  private readonly locks = new Map<string, Promise<void>>();

  createTracking(input: unknown): BillingTracking {
    const tracking = buildTracking(input);
    if (this.trackings.has(tracking.trackingId)) {
      throw new BillingError(
        'DUPLICATE_ID',
        `Tracking '${tracking.trackingId}' already exists.`,
        409,
        { trackingId: tracking.trackingId }
      );
    }
    this.trackings.set(tracking.trackingId, tracking);
    return cloneTracking(tracking);
  }

  getTracking(trackingId: string): BillingTracking {
    return cloneTracking(this.requireTracking(requireNonEmptyString(trackingId, 'trackingId')));
  }

  hasTracking(trackingId: string): boolean {
    return typeof trackingId === 'string' && this.trackings.has(trackingId);
  }

  summarize(trackingId: string, asOfDay: number): TrackingSummary {
    return summarizeTracking(this.requireTracking(requireNonEmptyString(trackingId, 'trackingId')), asOfDay);
  }

  async recordInsuranceDecision(trackingId: string, input: unknown): Promise<BillingTracking> {
    const id = requireNonEmptyString(trackingId, 'trackingId');
    return this.withLock(id, () => {
      const next = applyInsuranceDecision(this.requireTracking(id), input);
      this.trackings.set(id, next);
      return cloneTracking(next);
    });
  }

  async payBill(trackingId: string, input: unknown): Promise<PaymentReceipt> {
    const id = requireNonEmptyString(trackingId, 'trackingId');
    return this.withLock(id, () => {
      const { tracking: next, receipt } = applyPayment(this.requireTracking(id), input);
      this.trackings.set(id, next);
      return receipt;
    });
  }

  private requireTracking(trackingId: string): BillingTracking {
    const tracking = this.trackings.get(trackingId);
    if (!tracking) {
      throw new BillingError('TRACKING_NOT_FOUND', `Tracking '${trackingId}' was not found.`, 404, { trackingId });
    }
    return tracking;
  }

  private async withLock<T>(key: string, operation: () => T): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => gate);
    this.locks.set(key, chained);
    await previous;
    try {
      return operation();
    } finally {
      release();
      if (this.locks.get(key) === chained) {
        this.locks.delete(key);
      }
    }
  }
}

export type BillingHttpResponse = { status: number; body: Record<string, unknown> };

/**
 * Thin request adapter used by the portal API surface and by the scenario tests.
 * Returns an explicit status code so callers can distinguish success from typed
 * validation, authorization, conflict and not-found failures.
 */
export async function handleBillingRequest(
  tracker: MedicalBillTracker,
  action: string,
  payload: unknown
): Promise<BillingHttpResponse> {
  try {
    if (typeof action !== 'string' || action.trim().length === 0) {
      throw new BillingError('INVALID_INPUT', 'An action name is required.', 400, { action });
    }

    switch (action) {
      case 'create-tracking': {
        const tracking = tracker.createTracking(payload);
        return { status: 200, body: { ok: true, tracking } };
      }
      case 'get-tracking': {
        const trackingId = isPlainObject(payload) ? payload.trackingId : undefined;
        const tracking = tracker.getTracking(requireNonEmptyString(trackingId, 'trackingId'));
        return { status: 200, body: { ok: true, tracking } };
      }
      case 'summarize': {
        const trackingId = isPlainObject(payload) ? payload.trackingId : undefined;
        const asOfDay = isPlainObject(payload) ? payload.asOfDay : undefined;
        const summary = tracker.summarize(requireNonEmptyString(trackingId, 'trackingId'), requireIntegerInRange(asOfDay, 'asOfDay', 0, MAX_TRACKING_DAY));
        return { status: 200, body: { ok: true, summary } };
      }
      case 'record-insurance-decision': {
        const trackingId = isPlainObject(payload) ? payload.trackingId : undefined;
        const tracking = await tracker.recordInsuranceDecision(requireNonEmptyString(trackingId, 'trackingId'), payload);
        return { status: 200, body: { ok: true, tracking } };
      }
      case 'pay-bill': {
        const trackingId = isPlainObject(payload) ? payload.trackingId : undefined;
        const receipt = await tracker.payBill(requireNonEmptyString(trackingId, 'trackingId'), payload);
        return { status: 200, body: { ok: true, receipt } };
      }
      default:
        throw new BillingError('INVALID_INPUT', `Unknown action '${action}'.`, 400, { action });
    }
  } catch (error) {
    if (error instanceof BillingError) {
      return {
        status: error.status,
        body: { ok: false, code: error.code, message: error.message, details: error.details ?? null }
      };
    }
    throw error;
  }
}

