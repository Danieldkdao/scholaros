# Privacy, consent, and public-launch review

**Status:** engineering risk register only; no legal, privacy, FERPA, COPPA, GDPR, security, or accessibility compliance certification is claimed. The product currently has no age gate by design. That choice does not decide which laws, school contracts, guardian approvals, or provider duties apply. Qualified human counsel/privacy reviewers and the product owner must close the items below before any public child-facing launch.

## Data boundary to review

| Data                                                                        | Intended handling                                                                                                                           | Required human verification                                                                                                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Course pages, assignments, announcements, and source material               | Read only from explicitly authorized connections; scoped and stored locally for the configured account.                                     | Determine school/district authorization, permitted service-provider role, institutional agreements, retention, and disclosure duties.                                |
| Student questions, drafts, tutor responses, citations, and practice answers | Local session history by default; only a bounded currently authorized context package is sent for an explicitly requested Meta operation.   | Review each deployed provider/model's data-processing, retention, training, regional-processing, and incident terms for the exact account tier and API.              |
| Grades and grade-derived context                                            | Collection is off by default; one revocable setting controls access. A missing/stale/conflicting attempt record is not proof of completion. | Confirm any school/parent/student notice, consent, access, correction, deletion, and permitted educational purpose before enabling collection in a real institution. |
| Files, scans, handwriting, and source versions                              | User-selected files are bounded and processed under the selected course/session scope; raw originals remain locally owned and removable.    | Confirm copyright/license and school policy rights before sharing any source with an external provider; do not treat public access as processing permission.         |
| Dictation                                                                   | User-started microphone input becomes editable text; raw audio is memory-only and is not saved as a recording.                              | Verify provider terms, notices, consent/age implications, applicable wiretap/recording rules, and actual device permission behavior for each launch region.          |
| Learning preferences and observations                                       | Explicit preferences are distinct from provisional, evidence-linked learning observations; users can correct/delete them.                   | Review profiling/automated-decision, transparency, access, retention, and student/guardian rights for each deployment.                                               |
| Notifications and diagnostics                                               | Notifications are opt-in and should contain no grades, assignment text, tutor answer, or source excerpts. Logs/counters are content-free.   | Inspect the actual signed package, OS notification payloads, crash reporting, analytics, support tooling, and downstream processors for content leakage.             |
| Account/authentication data                                                 | Cloud account/authentication data is separated from local academic history.                                                                 | Review account deletion, support access, backups, breach response, and cross-border transfer terms.                                                                  |

## Required review before a child-facing public launch

1. **Audience and applicability:** document who may use the product, age ranges, school/home deployment, who selects the service, and who determines the educational purpose. Obtain qualified counsel's written assessment of COPPA, FERPA/education-record, GDPR and other applicable state/country requirements. No age-gate decision substitutes for that assessment.
2. **School and guardian authority:** identify the required notice, consent, school authorization, parent/guardian involvement, data access/export/correction/deletion, and complaint/appeal process for each intended deployment. Do not infer that a student's login or a school's LMS credentials authorize every downstream use.
3. **Provider and source rights:** review current Meta API/model terms, data-processing addenda, retention/training settings, subprocessors, endpoint/model capability and regions; also review connected LMS terms and every imported publisher/source license. Keep a dated record of the exact terms owner-reviewed. Never silently switch providers or infer terms from a model name.
4. **Data map and minimization:** confirm every field stored locally, sent to each provider, held in account/auth, included in crash/telemetry/notification, and retained in backups. Check that transcripts, grades, raw files/audio, cookies, prompts, and credentials never enter content-free logs or public demo material.
5. **Lifecycle and user controls:** exercise source removal, grade-consent revocation, account/device switching, offline cache expiry, memory correction/deletion, full account/local deletion, backup expiry, and late-job cancellation. Verify deleted data is not restored by a retry, cache, notification, model context, or migration.
6. **Security and incident response:** have an independent human review IPC/window trust, generated activity isolation, browser/profile separation, local endpoint ACLs, provider egress, secrets, retention, incident handling, and recovery. Keep software tests distinct from legal/compliance conclusions.
7. **Public material:** use only synthetic/anonymized courses, students, sources, and assignments unless the rights holder and affected person explicitly authorize a particular use. Do not publish student grades, questions, screenshots, browser identities, tokens, cookies, or school records.

## Official references checked November 3, 2026

These links identify primary sources for counsel's review; this note does not interpret them or determine whether they apply to ScholarOS:

- U.S. Federal Trade Commission, Children's Online Privacy Protection Rule (COPPA): https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa
- U.S. Department of Education, Student Privacy and FERPA resources: https://studentprivacy.ed.gov/ferpa
- European Union, General Data Protection Regulation, Regulation (EU) 2016/679: https://eur-lex.europa.eu/eli/reg/2016/679/oj
- Provider-specific Meta terms and data-processing documents must be retrieved from the authenticated/contractual account that will actually serve the product; this packet does not claim those terms were inspected or accepted.
- `docs/demo-script.md` records a publisher's explicit AI-ingestion restriction and keeps that textbook as a human-only link until written permission exists.

## Decision record

- Product age gate: **none by current product decision**; legal applicability unresolved.
- Public child-facing launch approval: **not granted**.
- Qualified legal/privacy approval: **not obtained in this packet**.
- Provider/school contract approval: **not obtained in this packet**.
- External submission/publication: **not performed**.
- Owner: product owner to name qualified counsel/privacy reviewer and record a dated decision and remediation evidence before launch.
