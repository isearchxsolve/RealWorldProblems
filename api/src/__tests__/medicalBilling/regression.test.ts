/**
 * SCENARIO_DEFECT_REGRESSION (regression) -- reproduction of the reported defect.
 *
 * Issue #1434: patients could not track which post-hospitalization bills were
 * genuinely due versus still pending insurance adjudication. The reported
 * failure was that a bill sat "waiting on insurance" indefinitely with no signal
 * that the insurer had gone quiet, so the payment/collections window lapsed and
 * the account silently escalated. This suite reproduces that condition and
 * asserts it is now resolved cleanly.
 */

import { ADJUDICATION_WINDOW_DAYS, BillingError, MedicalBillTracker } from '../../medicalBilling/medicalBillTracker';
import { PATIENT_ID, TRACKING_ID } from './fixtures';

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

/** A single post-discharge bill from the anesthesiology group reported in the issue. */
function singleBillTracking() {
  return {
    trackingId: TRACKING_ID,
    patientId: PATIENT_ID,
    bills: [
      {
        id: 'b-anesthesia',
        providerName: 'Anesthesiology Group',
        billedAmountCents: 184700,
        receivedDay: 0,
        dueDay: 90,
        insuranceStatus: 'pending'
      }
    ]
  };
}

function seededTracker(): MedicalBillTracker {
  const tracker = new MedicalBillTracker();
  tracker.createTracking(singleBillTracking());
  return tracker;
}

describe('SCENARIO_DEFECT_REGRESSION: pending bills are no longer silently presumed covered', () => {
  it('reproduces the reported defect condition and confirms it is resolved', () => {
    const tracker = seededTracker();

    // While the insurer is genuinely still within its adjudication window the
    // bill is correctly reported as pending insurance and needs no action.
    const withinWindow = tracker.summarize(TRACKING_ID, ADJUDICATION_WINDOW_DAYS - 1);
    expect(withinWindow.billStatuses['b-anesthesia']).toBe('pending-insurance');
    expect(withinWindow.billsNeedingActionIds).toEqual([]);

    // The reported defect: the bill sat "waiting on insurance" forever, so the
    // patient never acted and the 90-day window lapsed into collections. Now the
    // moment the adjudication window elapses the bill is escalated instead.
    const lapsed = tracker.summarize(TRACKING_ID, ADJUDICATION_WINDOW_DAYS);
    expect(lapsed.billStatuses['b-anesthesia']).toBe('escalate');
    expect(lapsed.pendingInsuranceBillIds).toEqual([]);
    expect(lapsed.escalatedBillIds).toEqual(['b-anesthesia']);
    expect(lapsed.billsNeedingActionIds).toEqual(['b-anesthesia']);
    expect(lapsed.nextActionableBillId).toBe('b-anesthesia');
  });

  it('prevents overpaying a bill that is still pending insurance', async () => {
    const tracker = seededTracker();
    const overpay = await captureRejection(tracker.payBill(TRACKING_ID, { billId: 'b-anesthesia', actorId: PATIENT_ID }));
    expect(overpay.code).toBe('BILL_NOT_DUE');

    const summary = tracker.summarize(TRACKING_ID, ADJUDICATION_WINDOW_DAYS);
    expect(summary.paidBillIds).toEqual([]);
    expect(summary.paidTotalCents).toBe(0);
  });

  it('leaves tracking state unchanged after each rejected defect-path request', async () => {
    const tracker = seededTracker();
    const before = JSON.stringify(tracker.getTracking(TRACKING_ID));

    await captureRejection(tracker.payBill(TRACKING_ID, { billId: 'b-anesthesia', actorId: PATIENT_ID }));
    await captureRejection(
      tracker.recordInsuranceDecision(TRACKING_ID, { billId: 'b-anesthesia', actorId: 'intruder', insuranceStatus: 'denied' })
    );
    await captureRejection(tracker.payBill(TRACKING_ID, { billId: 'b-ghost', actorId: PATIENT_ID }));

    expect(JSON.stringify(tracker.getTracking(TRACKING_ID))).toBe(before);
  });

  it('completes cleanly once the insurer decision is recorded', async () => {
    const tracker = seededTracker();
    const tracking = await tracker.recordInsuranceDecision(TRACKING_ID, {
      billId: 'b-anesthesia',
      actorId: PATIENT_ID,
      insuranceStatus: 'denied'
    });
    const bill = tracking.bills.find((entry) => entry.id === 'b-anesthesia');
    expect(bill?.insuranceStatus).toBe('denied');
    expect(bill?.patientResponsibilityCents).toBe(184700);

    const receipt = await tracker.payBill(TRACKING_ID, { billId: 'b-anesthesia', actorId: PATIENT_ID });
    expect(receipt.billId).toBe('b-anesthesia');
    expect(receipt.amountCents).toBe(184700);

    const summary = tracker.summarize(TRACKING_ID, ADJUDICATION_WINDOW_DAYS);
    expect(summary.paidTotalCents).toBe(184700);
    expect(summary.outstandingTotalCents).toBe(0);
    expect(summary.billsNeedingActionIds).toEqual([]);
    expect(summary.nextActionableBillId).toBeNull();
  });
});
