# Issue #1647 — Family health docs: willingness-to-pay landing page test

Repository artifact for the `type/experiment` issue
[muaddibco/RealWorldProblems#1647](https://github.com/muaddibco/RealWorldProblems/issues/1647),
created as the validation-plan child of parent problem
[#15](https://github.com/muaddibco/RealWorldProblems/issues/15) — "Family health
documents scattered across email and paper files".

## Primary uncertainty

Willingness-to-pay. Parents of school-age children in non-US markets (UK, AU, IE,
CA) feel the school-enrollment / clinic document scramble pain, but there is no
direct evidence they will commit £3–7/month for a dedicated app when most
competing tools are free or freemium.

## Hypothesis (from the issue)

Parents of school-age children (ages 4–12) in non-US English-speaking markets will
convert at ≥ 5% on a landing page framed around the school enrollment failure
moment, and ≥ 25% of sign-ups will select a paid tier (£3.99–6.99/month) when
pricing is shown explicitly.

## Deliverable in this repository

| Artifact | Path | Purpose |
|---|---|---|
| Experiment domain model | `api/src/experiments/willingnessToPay.ts` | Computes the pass/fail decision from campaign metrics; enforces forced tier selection, validation, de-duplication and atomic sign-up transitions. |
| HTTP endpoint | `api/src/functions/experimentWaitlist.ts` | `POST /api/experiments/family-health-docs/visits`, `POST /api/experiments/family-health-docs/signups`, `GET /api/experiments/family-health-docs/decision`. |
| Landing page | `experiments/1647-family-health-docs-wtp/landing-page.html` | The one-page test asset that forces an explicit tier selection at sign-up. |
| Companion tests | `api/src/experiments/__tests__/` | happy path, null, empty, boundary, negative, concurrency and regression scenarios. |
| Scenario entry points | `tests/` | Canonical `tests/<scenario>` paths for the required scenarios. |

The experiment is a `type/experiment` artifact. `classifyExperimentIssue`
guarantees it is never advanced, scored or archived through the `type/problem`
pipeline.

## Method (from the issue)

Landing page + waitlist with explicit tiered pricing and no free-trial language,
anchored to the school enrollment failure moment: offline health document vault,
QR share at the clinic or school desk, and vaccination certificate alerts.

| Tier | Price | Included |
|---|---|---|
| Free | £0 | 1 child, 10 documents |
| Vault | £3.99/month | unlimited children and documents, offline vault |
| Vault Pro | £6.99/month | QR share + vaccination certificate alerts |

- Tier selection is forced at sign-up; a sign-up without a tier is refused, never
  defaulted to Free, because paid-tier intent is the signal being measured.
- Traffic plan: 3–5 UK/AU/IE parent Facebook groups (Mumsnet, BabyCentre UK,
  school-parent groups), Reddit r/UKParenting and r/Parenting, optional £50–100
  paid social.
- Budget estimate: ~£100 (£30–50 paid social + £50–80 interview incentives).

## Success criteria (implemented in `decide()`)

| Signal | PASS | FAIL |
|---|---|---|
| Landing page → sign-up conversion | ≥ 5% of ≥ 300 visitors | < 3% |
| Paid tier intent (of sign-ups) | ≥ 25% select a paid tier | < 10% select paid |
| Qualitative | Sign-ups cite missed documents as a real stressor | "Google Drive is fine" |

The decision uses half-open threshold semantics: a value exactly on a PASS
threshold passes (≥ is inclusive) and a value exactly on a FAIL threshold does
**not** fail (fail is strictly below). With fewer than 300 unique visitors the
outcome is `INCONCLUSIVE` regardless of the observed ratio.

- `PASS` → run a concierge MVP: manually manage document ingestion and QR sharing
  for 5–10 waitlist parents through school enrollment season before writing
  production code, then build the MVP for a closed beta before the next
  back-to-school season.
- `FAIL (low WTP)` → revisit positioning (broader family document vault); if the
  willingness-to-pay signal stays absent, archive with `archive/no-wedge`.
- `FAIL (low traffic)` → the channel or message is off; re-frame around "school
  enrollment documents" and run 5 interviews before rebuilding the page.
- `INCONCLUSIVE` → extend traffic toward the 300-visitor floor at ≥ 5% conversion.

## Endpoint reference

| Method | Route | Auth | Result |
|---|---|---|---|
| `POST` | `/api/experiments/family-health-docs/visits` | anonymous | `200` on a unique visitor (idempotent per `visitorId`) |
| `POST` | `/api/experiments/family-health-docs/signups` | anonymous | `200` on sign-up; `400` validation; `409` duplicate email |
| `GET` | `/api/experiments/family-health-docs/decision` | `Authorization: Bearer $EXPERIMENT_ADMIN_TOKEN` | `200` decision; `401` without a valid credential |

`EXPERIMENT_ADMIN_TOKEN` is read from the environment; no credential value is
committed to the repository.

## Tests

```bash
yarn api:test          # full api workspace suite (includes the scenario suites)
yarn test:scenarios    # canonical tests/<scenario> entry points
```
