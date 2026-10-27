/**
 * SCENARIO_NEGATIVE_FAILURE (negative) -- companion negative suite.
 *
 * Malformed data, unauthorized callers and invalid credentials must be refused
 * immediately with a proper typed error code; the caller must never observe a
 * partially applied state change.
 */

import {
  BillingError,
  handleBillingRequest,
  MedicalBillTracker
} from '../../medicalBilling/medicalBillTracker';
import { createSeededTracker, PATIENT_ID, TRACKING_ID } from './fixtures';

function captureSync(fn: () => unknown): BillingError {
  try {
    fn();
  } catch (error) {
    if (error instanceof BillingError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected a BillingError but none was thrown.');
}

async function captureRejection(promise: Promise<unknown>): Promise<BillingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BillingError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected a BillingError rejection but the promise resolved.');
}

function bill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'b-only',
    providerName: 'Urgent Care',
    billedAmountCents: 5000,
    receivedDay: 0,
    dueDay: 30,
    insuranceStatus: 'pending',
    ...overrides
  };
}

describe('SCENARIO_NEGATIVE_FAILURE: malformed, unauthorized and invalid requests are refused', () => {
  it('refuses malformed bill data with typed errors', () => {
    expect(captureSync(() => new MedicalBillTracker().createTracking({ trackingId: TRACKING_ID, patientId: PATIENT_ID, bills: [bill({ billedAmountCents: 'lots' })] })).code).toBe('INVALID_INPUT');
    expect(captureSync(() => new MedicalBillTracker().createTracking({ trackingId: TRACKING_ID, patientId: PATIENT_ID, bills: [bill({ receivedDay: 40, dueDay: 10 })] })).code).toBe('OUT_OF_RANGE');
    expect(captureSync(() => new MedicalBillTracker().createTracking({ trackingId: TRACKING_ID, patientId: PATIENT_ID, bills: [bill({ insuranceStatus: 'maybe' })] })).code).toBe('INVALID_INPUT');
    expect(captureSync(() => new MedicalBillTracker().createTracking({ trackingId: TRACKING_ID, patientId: PATIENT_ID, bills: [bill({ patientResponsibilityCents: 100 })] })).code).toBe('INVALID_INPUT');
    expect(captureSync(() => new MedicalBillTracker().createTracking({ trackingId: TRACKING_ID, patientId: PATIENT_ID, bills: [bill({ insuranceStatus: 'adjudicated', patientResponsibilityCents: 6000 })] })).code).toBe('OUT_OF_RANGE');
  });

  it('refuses duplicate identifiers with 409 DUPLICATE_ID', () => {
    const duplicateBill = captureSync(() =>
      new MedicalBillTracker().createTracking({ trackingId: TRACKING_ID, patientId: PATIENT_ID, bills: [bill(), bill()] })
    );
    expect(duplicateBill.code).toBe('DUPLICATE_ID');
    expect(duplicateBill.status).toBe(409);

    const tracker = createSeededTracker();
    const duplicateTracking = captureSync(() => tracker.createTracking({ trackingId: TRACKING_ID, patientId: PATIENT_ID, bills: [bill()] }));
    expect(duplicateTracking.code).toBe('DUPLICATE_ID');
    expect(duplicateTracking.status).toBe(409);
  });
});

describe('SCENARIO_NEGATIVE_FAILURE: authorization, conflicts and out-of-sequence operations', () => {
  it('refuses callers that lack authority with 403 UNAUTHORIZED_ACTOR', async () => {
    const tracker = createSeededTracker();

    const decision = await captureRejection(
      tracker.recordInsuranceDecision(TRACKING_ID, { billId: 'b-hospital', actorId: 'intruder', insuranceStatus: 'denied' })
    );
    expect(decision.code).toBe('UNAUTHORIZED_ACTOR');
    expect(decision.status).toBe(403);

    const payment = await handleBillingRequest(tracker, 'pay-bill', {
      trackingId: TRACKING_ID,
      billId: 'b-hospital',
      actorId: 'intruder'
    });
    expect(payment.status).toBe(403);
    expect(payment.body.code).toBe('UNAUTHORIZED_ACTOR');
    expect(payment.body.ok).toBe(false);
  });

  it('refuses payments on a bill that is still pending insurance (BILL_NOT_DUE)', async () => {
    const tracker = createSeededTracker();
    const pending = await captureRejection(tracker.payBill(TRACKING_ID, { billId: 'b-hospital', actorId: PATIENT_ID }));
    expect(pending.code).toBe('BILL_NOT_DUE');
    expect(pending.status).toBe(409);
  });

  it('refuses unknown bills and unknown trackings with 404', async () => {
    const tracker = createSeededTracker();

    const unknownBill = await captureRejection(
      tracker.payBill(TRACKING_ID, { billId: 'b-ghost', actorId: PATIENT_ID })
    );
    expect(unknownBill.code).toBe('UNKNOWN_BILL');
    expect(unknownBill.status).toBe(404);

    const unknownTracking = await captureRejection(
      tracker.recordInsuranceDecision('stay-ghost', { billId: 'b-hospital', actorId: PATIENT_ID, insuranceStatus: 'denied' })
    );
    expect(unknownTracking.code).toBe('TRACKING_NOT_FOUND');
    expect(unknownTracking.status).toBe(404);
  });

  it('refuses to pay or re-adjudicate a bill twice', async () => {
    const tracker = createSeededTracker();
    await tracker.recordInsuranceDecision(TRACKING_ID, {
      billId: 'b-hospital',
      actorId: PATIENT_ID,
      insuranceStatus: 'adjudicated',
      patientResponsibilityCents: 180000
    });
    await tracker.payBill(TRACKING_ID, { billId: 'b-hospital', actorId: PATIENT_ID });

    const doublePay = await captureRejection(tracker.payBill(TRACKING_ID, { billId: 'b-hospital', actorId: PATIENT_ID }));
    expect(doublePay.code).toBe('BILL_ALREADY_PAID');
    expect(doublePay.status).toBe(409);

    const doubleAdjudicate = await captureRejection(
      tracker.recordInsuranceDecision(TRACKING_ID, { billId: 'b-hospital', actorId: PATIENT_ID, insuranceStatus: 'denied' })
    );
    expect(doubleAdjudicate.code).toBe('INSURANCE_ALREADY_ADJUDICATED');
    expect(doubleAdjudicate.status).toBe(409);
  });

  it('surfaces the typed error code through the request adapter', async () => {
    const tracker = createSeededTracker();

    const conflict = await handleBillingRequest(tracker, 'pay-bill', {
      trackingId: TRACKING_ID,
      billId: 'b-anesthesia',
      actorId: PATIENT_ID
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('BILL_NOT_DUE');

    const malformed = await handleBillingRequest(tracker, 'create-tracking', {
      trackingId: '',
      patientId: PATIENT_ID,
      bills: [bill()]
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('EMPTY_FIELD');

    const unknownAction = await handleBillingRequest(tracker, 'nope', {});
    expect(unknownAction.status).toBe(400);
    expect(unknownAction.body.code).toBe('INVALID_INPUT');
  });
});

