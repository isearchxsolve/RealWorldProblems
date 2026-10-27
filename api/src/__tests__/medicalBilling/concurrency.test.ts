/**
 * SCENARIO_CONCURRENCY_RACE (concurrency) -- companion concurrency suite.
 *
 * Multiple simultaneous requests against the same bill must produce an atomic
 * transition: the first operation wins, the second is safely rejected, and no
 * bill is ever paid twice (zero double spend).
 */

import { BillingError, MedicalBillTracker } from '../../medicalBilling/medicalBillTracker';
import {
  adjudicateAll,
  BASE_BILL_IDS,
  createSeededTracker,
  EXPECTED_RESPONSIBILITY_TOTAL_CENTS,
  PATIENT_ID,
  TRACKING_ID
} from './fixtures';

function reasonOf(result: PromiseSettledResult<unknown>): BillingError {
  if (result.status !== 'rejected') {
    throw new Error('Expected a rejected result.');
  }
  if (result.reason instanceof BillingError) {
    return result.reason;
  }
  throw result.reason;
}

describe('SCENARIO_CONCURRENCY_RACE: simultaneous requests are atomic', () => {
  it('pays a single bill exactly once under 10 concurrent requests (no double spend)', async () => {
    const tracker = createSeededTracker();
    await tracker.recordInsuranceDecision(TRACKING_ID, {
      billId: 'b-hospital',
      actorId: PATIENT_ID,
      insuranceStatus: 'adjudicated',
      patientResponsibilityCents: 180000
    });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => tracker.payBill(TRACKING_ID, { billId: 'b-hospital', actorId: PATIENT_ID }))
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const failure of rejected) {
      expect(reasonOf(failure).code).toBe('BILL_ALREADY_PAID');
    }

    const summary = tracker.summarize(TRACKING_ID, 60);
    expect(summary.paidBillIds).toEqual(['b-hospital']);
    expect(summary.paidTotalCents).toBe(180000);
    expect(summary.billStatuses['b-hospital']).toBe('paid');
  });

  it('records an insurer decision exactly once under concurrent requests', async () => {
    const tracker = createSeededTracker();

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        tracker.recordInsuranceDecision(TRACKING_ID, {
          billId: 'b-anesthesia',
          actorId: PATIENT_ID,
          insuranceStatus: 'denied'
        })
      )
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(4);
    for (const failure of rejected) {
      expect(reasonOf(failure).code).toBe('INSURANCE_ALREADY_ADJUDICATED');
    }

    const bill = tracker.getTracking(TRACKING_ID).bills.find((entry) => entry.id === 'b-anesthesia');
    expect(bill?.insuranceStatus).toBe('denied');
    expect(bill?.patientResponsibilityCents).toBe(184700);
  });

  it('allows concurrent, independent payments and never double counts', async () => {
    const tracker: MedicalBillTracker = createSeededTracker();
    await adjudicateAll(tracker);

    const results = await Promise.allSettled(
      BASE_BILL_IDS.map((billId) => tracker.payBill(TRACKING_ID, { billId, actorId: PATIENT_ID }))
    );
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);

    const summary = tracker.summarize(TRACKING_ID, 60);
    expect(summary.paidTotalCents).toBe(EXPECTED_RESPONSIBILITY_TOTAL_CENTS);
    expect([...summary.paidBillIds].sort()).toEqual([...BASE_BILL_IDS].sort());
    expect(summary.outstandingTotalCents).toBe(0);
  });
});
