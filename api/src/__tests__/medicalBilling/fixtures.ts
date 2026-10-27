import { BillingTracking, MedicalBillTracker } from '../../medicalBilling/medicalBillTracker';

/** Shared fixtures for the post-hospitalization bill tracking scenario suites (#1434). */

export const PATIENT_ID = 'patient-1434';
export const TRACKING_ID = 'stay-1434';

export type BillFixture = {
  id: string;
  providerName: string;
  billedAmountCents: number;
  receivedDay: number;
  dueDay: number;
  insuranceStatus: string;
  patientResponsibilityCents?: number;
};

/**
 * A realistic US inpatient episode: five separate bills from independent
 * providers that bill the insurer separately and arrive weeks apart, each still
 * awaiting insurance adjudication.
 */
export const BASE_BILLS: BillFixture[] = [
  { id: 'b-hospital', providerName: 'General Hospital', billedAmountCents: 900000, receivedDay: 10, dueDay: 90, insuranceStatus: 'pending' },
  { id: 'b-anesthesia', providerName: 'Anesthesiology Group', billedAmountCents: 184700, receivedDay: 45, dueDay: 135, insuranceStatus: 'pending' },
  { id: 'b-radiology', providerName: 'Radiology Associates', billedAmountCents: 64000, receivedDay: 20, dueDay: 80, insuranceStatus: 'pending' },
  { id: 'b-attending', providerName: 'Attending Physician', billedAmountCents: 120000, receivedDay: 30, dueDay: 100, insuranceStatus: 'pending' },
  { id: 'b-lab', providerName: 'Regional Lab Services', billedAmountCents: 41500, receivedDay: 15, dueDay: 75, insuranceStatus: 'pending' }
];

export const BASE_BILL_IDS = BASE_BILLS.map((bill) => bill.id);
export const BASE_TOTAL_BILLED_CENTS = BASE_BILLS.reduce((total, bill) => total + bill.billedAmountCents, 0);

/** An out-of-network anesthesiologist is denied; the remaining claims adjudicate. */
export const DENIED_BILL_ID = 'b-anesthesia';

export const ADJUDICATED_RESPONSIBILITY: Record<string, number> = {
  'b-hospital': 180000,
  'b-radiology': 6400,
  'b-attending': 12000,
  'b-lab': 4150
};

export const EXPECTED_RESPONSIBILITY_TOTAL_CENTS =
  Object.values(ADJUDICATED_RESPONSIBILITY).reduce((total, amount) => total + amount, 0) +
  BASE_BILLS.find((bill) => bill.id === DENIED_BILL_ID)!.billedAmountCents;

export function baseTrackingInput(): {
  trackingId: string;
  patientId: string;
  bills: BillFixture[];
} {
  return {
    trackingId: TRACKING_ID,
    patientId: PATIENT_ID,
    bills: BASE_BILLS.map((bill) => ({ ...bill }))
  };
}

export function createSeededTracker(): MedicalBillTracker {
  const tracker = new MedicalBillTracker();
  tracker.createTracking(baseTrackingInput());
  return tracker;
}

/** Records the insurer decision for every bill in the episode. */
export async function adjudicateAll(tracker: MedicalBillTracker): Promise<BillingTracking> {
  let tracking = tracker.getTracking(TRACKING_ID);
  for (const startingBill of BASE_BILLS) {
    if (startingBill.id === DENIED_BILL_ID) {
      tracking = await tracker.recordInsuranceDecision(TRACKING_ID, {
        billId: startingBill.id,
        actorId: PATIENT_ID,
        insuranceStatus: 'denied'
      });
    } else {
      tracking = await tracker.recordInsuranceDecision(TRACKING_ID, {
        billId: startingBill.id,
        actorId: PATIENT_ID,
        insuranceStatus: 'adjudicated',
        patientResponsibilityCents: ADJUDICATED_RESPONSIBILITY[startingBill.id]
      });
    }
  }
  return tracking;
}
