# Issue #1634 — VaultKid / family health vault: willingness-to-pay validation

Repository artifact for the `type/experiment` issue
[muaddibco/RealWorldProblems#1634](https://github.com/muaddibco/RealWorldProblems/issues/1634),
created as the validation-plan child of parent problem #15.

## Primary uncertainty

Willingness-to-pay. Parents feel the pain, but there was no direct evidence they
will pay $3.99–6.99/month for a dedicated app over free tools (Google Drive, email
folders) in a freemium competitor landscape.

## Deliverable in this repository

| Artifact | Path | Purpose |
|---|---|---|
| Experiment domain model | `api/src/experiments/willingnessToPay.ts` | Computes the pass/fail decision from campaign metrics; enforces validation, de-duplication and atomic sign-up transitions. |
| HTTP endpoint | `api/src/functions/experimentWaitlist.ts` | `POST /api/experiments/vaultkid/visits`, `POST /api/experiments/vaultkid/signups`, `GET /api/experiments/vaultkid/decision`. |
| Landing page | `experiments/1634-vaultkid-wtp/landing-page.html` | The one-page test asset that forces an explicit tier selection at sign-up. |
| Companion tests | `api/src/experiments/__tests__/` | happy path, null, empty, boundary, negative, concurrency and regression scenarios. |

The experiment is a `type/experiment` artifact. `classifyExperimentIssue` guarantees
it is never advanced, scored or archived through the `type/problem` pipeline.

## Method (from the issue)

Landing page + waitlist with explicit tiered pricing:

| Tier | Price | Included |
|---|---|---|
| Free | $0 | 1 child, 10 docs |
| Vault Basic | $3.99/month | unlimited children, offline vault |
| Vault Plus | $6.99/month | QR share + vaccination alerts |

- Tier selection is forced at sign-up (no free-trial language).
- Traffic target: 300–400 unique visitors over 2–3 weeks.
- Scope: parents of children ages 4–12 in UK, Ireland, Australia or Canada.

## Success criteria (implemented in `decide()`)

| Signal | PASS | FAIL |
|---|---|---|
| Landing page → sign-up conversion | ≥ 5% of ≥ 300 unique visitors | < 3% |
| Paid tier intent (of sign-ups) | ≥ 25% select a paid tier | < 10% select paid |
| Qualitative | Sign-ups cite missed documents as a real stressor | "Google Drive is fine" |

The decision uses half-open threshold semantics: a value exactly on a PASS
threshold passes and a value exactly on a FAIL threshold does **not** fail. With
fewer than 300 unique visitors the outcome is `INCONCLUSIVE` regardless of ratio.

- `PASS` → run a concierge MVP for 5–10 waitlist parents through school enrollment season.
- `FAIL` → revisit positioning (broader family document vault); if WTP stays absent, archive with `archive/no-wedge`.
- `INCONCLUSIVE` → extend traffic to the 400-visitor target before deciding.

## Endpoint reference

| Method | Route | Auth | Result |
|---|---|---|---|
| `POST` | `/api/experiments/vaultkid/visits` | anonymous | `200` on a unique visitor (idempotent per `visitorId`) |
| `POST` | `/api/experiments/vaultkid/signups` | anonymous | `200` on sign-up; `400` validation; `409` duplicate email |
| `GET` | `/api/experiments/vaultkid/decision` | `Authorization: Bearer $EXPERIMENT_ADMIN_TOKEN` | `200` decision; `401` without a valid credential |

`EXPERIMENT_ADMIN_TOKEN` is read from the environment; no credential value is
committed to the repository.
