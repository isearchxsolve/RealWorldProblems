/**
 * SCENARIO_NULL_INPUT (null), SCENARIO_EMPTY_INPUT (empty) and
 * SCENARIO_BOUNDARY_LIMIT (boundary) -- companion boundary suite.
 *
 * Null/undefined arguments, empty strings, empty collections, whitespace-only
 * values and exact upper/lower bound values must be handled explicitly: no
 * unhandled crash, no silent state corruption, and both the insurance
 * adjudication window and the payment window are evaluated strictly as
 * half-open intervals.
 */

import {
  ADJUDICATION_WINDOW_DAYS,
  BillingError,
  buildTracking,
  classifyBill,
  handleBillingRequest,
  MAX_BILL_AMOUNT_CENTS,
  MAX_BILLS,
  MAX_PAYMENT_WINDOW_DAYS,
  MAX_TRACKING_DAY,
  MedicalBillTracker,
  ProviderBill
} from '../../medicalBilling/medicalBillTracker';
import { createSeededTracker, PATIENT_ID, TRACKING_ID } from './fixtures';

function captureError(fn: () => unknown): BillingError {
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

function singleBillInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trackingId: 'stay-single',
    patientId: PATIENT_ID,
    bills: [
      {
        id: 'b-only',
        providerName: 'Urgent Care',
        billedAmountCents: 5000,
        receivedDay: 0,
        dueDay: 10,
        insuranceStatus: 'pending',
        ...overrides
      }
    ]
  };
}

describe('SCENARIO_NULL_INPUT: null/undefined arguments are rejected gracefully', () => {
  it('rejects null and undefined payloads with a typed INVALID_INPUT error', () => {
    const tracker = new MedicalBillTracker();
    const nullError = captureError(() => tracker.createTracking(null));
    expect(nullError.code).toBe('INVALID_INPUT');
    expect(nullError.status).toBe(400);
    expect(captureError(() => tracker.createTracking(undefined)).code).toBe('INVALID_INPUT');
  });

  it('rejects null required fields with MISSING_FIELD', () => {
    expect(captureError(() => buildTracking({ trackingId: null, patientId: PATIENT_ID, bills: [] })).code).toBe('MISSING_FIELD');
    expect(captureError(() => buildTracking({ trackingId: TRACKING_ID, patientId: null, bills: [] })).code).toBe('MISSING_FIELD');
    expect(captureError(() => buildTracking({ trackingId: TRACKING_ID, patientId: PATIENT_ID, bills: null })).code).toBe('MISSING_FIELD');
    expect(captureError(() => buildTracking(singleBillInput({ billedAmountCents: null }))).code).toBe('MISSING_FIELD');
    expect(
      captureError(() =>
        buildTracking(singleBillInput({ insuranceStatus: 'adjudicated', patientResponsibilityCents: null }))
      ).code
    ).toBe('MISSING_FIELD');
  });

  it('defaults null optional fields instead of crashing', () => {
    const tracking = buildTracking(singleBillInput({ insuranceStatus: null }));
    expect(tracking.bills[0].insuranceStatus).toBe('not-billed');
    expect(tracking.bills[0].patientResponsibilityCents).toBeNull();
    expect(tracking.bills[0].paid).toBe(false);
  });
});

describe('SCENARIO_EMPTY_INPUT: empty and whitespace-only values are rejected', () => {
  it('rejects empty and whitespace-only identifiers with EMPTY_FIELD', () => {
    expect(captureError(() => buildTracking({ trackingId: '', patientId: PATIENT_ID, bills: [] })).code).toBe('EMPTY_FIELD');
    expect(captureError(() => buildTracking({ trackingId: '   ', patientId: PATIENT_ID, bills: [] })).code).toBe('EMPTY_FIELD');
    expect(captureError(() => buildTracking(singleBillInput({ providerName: '  ' }))).code).toBe('EMPTY_FIELD');
  });

  it('rejects an empty bill collection with a clear diagnostic and no state change', () => {
    const tracker = new MedicalBillTracker();
    const error = captureError(() => tracker.createTracking({ trackingId: TRACKING_ID, patientId: PATIENT_ID, bills: [] }));
    expect(error.code).toBe('EMPTY_FIELD');
    expect(tracker.hasTracking(TRACKING_ID)).toBe(false);
  });

  it('rejects a whitespace-only bill id without corrupting existing state', async () => {
    const tracker = createSeededTracker();
    const before = JSON.stringify(tracker.getTracking(TRACKING_ID));
    const rejection = await captureRejection(
      tracker.recordInsuranceDecision(TRACKING_ID, { billId: '   ', actorId: PATIENT_ID, insuranceStatus: 'denied' })
    );
    expect(rejection.code).toBe('EMPTY_FIELD');
    expect(JSON.stringify(tracker.getTracking(TRACKING_ID))).toBe(before);
  });
});

describe('SCENARIO_BOUNDARY_LIMIT: exact bounds are evaluated strictly', () => {
  it('accepts 1 bill and the maximum of 12, and rejects 13', () => {
    expect(buildTracking(singleBillInput()).bills).toHaveLength(1);

    const many = Array.from({ length: MAX_BILLS }, (_, index) => ({
      id: `b-${index}`,
      providerName: `Provider ${index}`,
      billedAmountCents: 1000 + index,
      receivedDay: index,
      dueDay: index + 30,
      insuranceStatus: 'pending'
    }));
    expect(buildTracking({ trackingId: 'stay-max', patientId: PATIENT_ID, bills: many }).bills).toHaveLength(MAX_BILLS);

    const tooMany = [...many, { id: 'b-extra', providerName: 'Extra', billedAmountCents: 500, receivedDay: 0, dueDay: 10 }];
    expect(captureError(() => buildTracking({ trackingId: 'stay-too-many', patientId: PATIENT_ID, bills: tooMany })).code).toBe(
      'OUT_OF_RANGE'
    );
  });

  it('accepts the minimum (1 cent) and maximum billed amounts, and rejects 0 and max+1', () => {
    const withAmount = (billedAmountCents: number) => buildTracking(singleBillInput({ billedAmountCents }));

    expect(withAmount(1).bills[0].billedAmountCents).toBe(1);
    expect(withAmount(MAX_BILL_AMOUNT_CENTS).bills[0].billedAmountCents).toBe(MAX_BILL_AMOUNT_CENTS);
    expect(captureError(() => withAmount(0)).code).toBe('OUT_OF_RANGE');
    expect(captureError(() => withAmount(MAX_BILL_AMOUNT_CENTS + 1)).code).toBe('OUT_OF_RANGE');
  });

  it('accepts tracking day bounds 0 and MAX, and rejects -1 and MAX+1', () => {
    const onDay = (day: number) => buildTracking(singleBillInput({ receivedDay: day, dueDay: day }));

    expect(onDay(0).bills[0].receivedDay).toBe(0);
    expect(onDay(MAX_TRACKING_DAY).bills[0].dueDay).toBe(MAX_TRACKING_DAY);
    expect(captureError(() => onDay(-1)).code).toBe('OUT_OF_RANGE');
    expect(captureError(() => onDay(MAX_TRACKING_DAY + 1)).code).toBe('OUT_OF_RANGE');
  });

  it('evaluates the half-open payment window strictly at the threshold', () => {
    const receivedDay = 10;
    const withinWindow = buildTracking(singleBillInput({ receivedDay, dueDay: receivedDay + MAX_PAYMENT_WINDOW_DAYS - 1 }));
    expect(withinWindow.bills[0].dueDay - withinWindow.bills[0].receivedDay).toBe(MAX_PAYMENT_WINDOW_DAYS - 1);

    expect(
      captureError(() => buildTracking(singleBillInput({ receivedDay, dueDay: receivedDay + MAX_PAYMENT_WINDOW_DAYS }))).code
    ).toBe('OUT_OF_RANGE');
    expect(captureError(() => buildTracking(singleBillInput({ receivedDay, dueDay: receivedDay - 1 }))).code).toBe(
      'OUT_OF_RANGE'
    );
  });

  it('evaluates the half-open insurance adjudication window strictly at the threshold', () => {
    const bill: ProviderBill = {
      id: 'b-pending',
      providerName: 'Radiology Associates',
      billedAmountCents: 64000,
      receivedDay: 0,
      dueDay: 90,
      insuranceStatus: 'pending',
      patientResponsibilityCents: null,
      paid: false
    };

    expect(classifyBill(bill, ADJUDICATION_WINDOW_DAYS - 1)).toBe('pending-insurance');
    expect(classifyBill(bill, ADJUDICATION_WINDOW_DAYS)).toBe('escalate');
  });

  it('rejects a whitespace-only action with a 400 diagnostic', async () => {
    const response = await handleBillingRequest(new MedicalBillTracker(), '   ', {});
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_INPUT');
  });
});

