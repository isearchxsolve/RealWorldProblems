/**
 * SCENARIO_HAPPY_PATH (happy_path)
 *
 * Valid inputs per the specification: a patient discharged from a hospital stay
 * tracks every provider bill end to end. The core business path -- create the
 * tracking record, record each insurer decision, then pay each bill that is
 * genuinely due -- completes with a success (200) result and the expected state
 * transition.
 */

import { handleBillingRequest, MedicalBillTracker } from '../../medicalBilling/medicalBillTracker';
import {
  ADJUDICATED_RESPONSIBILITY,
  adjudicateAll,
  baseTrackingInput,
  BASE_BILL_IDS,
  BASE_TOTAL_BILLED_CENTS,
  createSeededTracker,
  DENIED_BILL_ID,
  EXPECTED_RESPONSIBILITY_TOTAL_CENTS,
  PATIENT_ID,
  TRACKING_ID
} from './fixtures';

describe('SCENARIO_HAPPY_PATH: post-hospitalization bill tracking', () => {
  it('creates the tracking record and exposes the full bill state without loss', () => {
    const tracker = new MedicalBillTracker();
    const tracking = tracker.createTracking(baseTrackingInput());

    expect(tracking.trackingId).toBe(TRACKING_ID);
    expect(tracking.patientId).toBe(PATIENT_ID);
    expect(tracking.bills.map((bill) => bill.id)).toEqual(BASE_BILL_IDS);
    expect(tracking.bills.every((bill) => bill.insuranceStatus === 'pending')).toBe(true);
    expect(tracking.bills.every((bill) => bill.paid === false)).toBe(true);
    expect(tracking.bills.reduce((total, bill) => total + bill.billedAmountCents, 0)).toBe(BASE_TOTAL_BILLED_CENTS);
  });

  it('adjudicates every claim and pays each genuinely due bill exactly once', async () => {
    const tracker = createSeededTracker();

    const initialSummary = tracker.summarize(TRACKING_ID, 50);
    expect(initialSummary.pendingInsuranceBillIds).toContain('b-anesthesia');
    expect(initialSummary.paidTotalCents).toBe(0);

    await adjudicateAll(tracker);

    const receipts = [];
    for (const billId of BASE_BILL_IDS) {
      const receipt = await tracker.payBill(TRACKING_ID, { billId, actorId: PATIENT_ID });
      receipts.push(receipt);
      expect(receipt.trackingId).toBe(TRACKING_ID);
      expect(receipt.amountCents).toBeGreaterThan(0);
    }
    expect(receipts.map((receipt) => receipt.billId)).toEqual(BASE_BILL_IDS);
    expect(receipts.find((receipt) => receipt.billId === DENIED_BILL_ID)?.amountCents).toBe(184700);

    const finalSummary = tracker.summarize(TRACKING_ID, 60);
    expect(finalSummary.paidTotalCents).toBe(EXPECTED_RESPONSIBILITY_TOTAL_CENTS);
    expect(finalSummary.outstandingTotalCents).toBe(0);
    expect([...finalSummary.paidBillIds].sort()).toEqual([...BASE_BILL_IDS].sort());
    expect(finalSummary.pendingInsuranceBillIds).toEqual([]);
    expect(finalSummary.nextActionableBillId).toBeNull();
  });

  it('returns a 200 success response through the request adapter and applies the state transition', async () => {
    const tracker = new MedicalBillTracker();

    const createResponse = await handleBillingRequest(tracker, 'create-tracking', baseTrackingInput());
    expect(createResponse.status).toBe(200);
    expect(createResponse.body.ok).toBe(true);

    const decisionResponse = await handleBillingRequest(tracker, 'record-insurance-decision', {
      trackingId: TRACKING_ID,
      billId: 'b-hospital',
      actorId: PATIENT_ID,
      insuranceStatus: 'adjudicated',
      patientResponsibilityCents: ADJUDICATED_RESPONSIBILITY['b-hospital']
    });
    expect(decisionResponse.status).toBe(200);
    expect(decisionResponse.body.ok).toBe(true);

    const payResponse = await handleBillingRequest(tracker, 'pay-bill', {
      trackingId: TRACKING_ID,
      billId: 'b-hospital',
      actorId: PATIENT_ID
    });
    expect(payResponse.status).toBe(200);
    expect(payResponse.body.ok).toBe(true);

    const summaryResponse = await handleBillingRequest(tracker, 'summarize', { trackingId: TRACKING_ID, asOfDay: 60 });
    expect(summaryResponse.status).toBe(200);
    const summary = summaryResponse.body.summary as { paidTotalCents: number; billStatuses: Record<string, string> };
    expect(summary.paidTotalCents).toBe(ADJUDICATED_RESPONSIBILITY['b-hospital']);
    expect(summary.billStatuses['b-hospital']).toBe('paid');
  });
});
