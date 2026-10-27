# Issue #1614 — Family health document vault: willingness-to-pay validation

Repository artifact for the `type/experiment` issue
[muaddibco/RealWorldProblems#1614](https://github.com/muaddibco/RealWorldProblems/issues/1614),
created as the validation-plan child of parent problem
[#15](https://github.com/muaddibco/RealWorldProblems/issues/15) — "Family health
document management: organizing, retrieving, and sharing children's health
documents at point of need."

## Primary uncertainty

Willingness-to-pay. Parents clearly feel the pain, but there was no direct
evidence they will pay £2.99–4.99/month for a dedicated app while free
workarounds (Google Drive, camera roll) and freemium competitors exist.

## Hypothesis (from the issue)

If we present a landing page describing a mobile-first child health document
vault (organize, retrieve, QR-share at point of need) with explicit tiered pricing
(Free / £2.99/month / £4.99/month) to UK/AU/IE parents of school-age children, at
least 5% of visitors will sign up and at least 25% of sign-ups will select a paid
tier.

## Deliverable in this repository

| Artifact | Path | Purpose |
|---|---|---|
| Experiment domain model | `api/src/experiments/familyHealthVaultWtp.ts` | Computes the pass/fail decision from campaign metrics; enforces validation, de-duplication and atomic sign-up transitions. |
| HTTP endpoint | `api/src/functions/experimentFamilyHealthVault.ts` | `POST /api/experiments/family-health-vault/visits`, `POST /api/experiments/family-health-vault/signups`, `GET /api/experiments/family-health-vault/decision`. |
| Landing page | `experiments/1614-family-health-vault-wtp/landing-page.html` | The one-page test asset that forces an explicit tier selection at sign-up. |
| Companion tests | `api/src/experiments/__tests__/` | happy path, null, empty, boundary, negative, concurrency and regression scenarios. |
| Scenario entry points | `tests/` | Canonical `tests/<scenario>` paths for the required scenarios. |

The experiment is a `type/experiment` artifact. `classifyExperimentIssue`
guarantees it is never advanced, scored or archived through the `type/problem`
pipeline.

## Method (from the issue)

Landing page + waitlist with explicit tiered pricing and no free-trial language,
framed around the school enrollment failure moment:

| Tier | Price | Included |
|---|---|---|
| Free | £0 | 1 child, 10 docs |
| Vault Basic | £2.99/month | unlimited children, offline vault |
| Vault Plus | £4.99/month | QR share + immunisation alerts |

- Tier selection is forced at sign-up.
- Target: 300–400 unique visitors over 2 weeks.
- Recruiting: Mumsnet, BabyCentre UK, school-parent Facebook groups, Reddit
  r/UKParenting and r/Parenting; optional £50–100 paid social in UK/AU/IE.

## Success criteria (implemented in `decide()`)

| Signal | PASS | FAIL |
|---|---|---|
| Landing page → sign-up conversion | ≥ 5% of ≥ 300 unique visitors | < 3% |
| Paid tier intent (of sign-ups) | ≥ 25% select a paid tier | < 10% select paid |
| Qualitative | Sign-ups cite missed documents as a real stressor | "Google Drive is fine" |

The decision uses half-open threshold semantics: a value exactly on a PASS
threshold passes and a value exactly on a FAIL threshold does **not** fail. With
fewer than 300 unique visitors the outcome is `INCONCLUSIVE` regardless of ratio.

- `PASS` → run a concierge MVP for 5–10 waitlist parents through school
  enrollment season before writing production code.
- `FAIL` → revisit positioning (broader family document vault); if the WTP signal
  stays absent, archive with `archive/no-wedge`.
- `INCONCLUSIVE` → extend traffic to the 400-visitor target before deciding.

## Endpoint reference

| Method | Route | Auth | Result |
|---|---|---|---|
| `POST` | `/api/experiments/family-health-vault/visits` | anonymous | `200` on a unique visitor (idempotent per `visitorId`) |
| `POST` | `/api/experiments/family-health-vault/signups` | anonymous | `200` on sign-up; `400` validation; `409` duplicate email |
| `GET` | `/api/experiments/family-health-vault/decision` | `Authorization: Bearer $EXPERIMENT_ADMIN_TOKEN` | `200` decision; `401` without a valid credential |

`EXPERIMENT_ADMIN_TOKEN` is read from the environment; no credential value is
committed to the repository.

## Tests

```bash
yarn api:test          # full api workspace suite (includes the scenario suites)
yarn test:scenarios    # canonical tests/<scenario> entry points
```
