# Reproducible science learning demo

**Status:** prepared runbook only; it has not been run against the combined product. Expected behavior below is an acceptance check, not an observed result. Record actual outcomes only after testing the integrated app and configured service.

## Scenario

**A pendulum you can change, explain, and remember.** Show one focused introductory-physics study session that connects an original, test-owned source note to a working simulation, practice feedback, a user-controlled learning preference, and saved activity state. A second synthetic assignment demonstrates conceptual-only help while work is active.

## Rights-safe fixture

Use a newly created test-owned local profile and a synthetic fixture course named **Intro Physics Lab**. Do not connect a student's LMS account, use real grades/questions, or put personal content into the recording. Create a local Context note named **Pendulum investigation brief — fixture v1** with these original, demo-authored facts:

1. The investigation studies an ideal simple pendulum at a small release angle, with a light string and negligible friction.
2. For this fixture, the model is `T = 2π√(L/g)`; bob mass is not an input to the ideal period.
3. The activity should let the learner change length, mass, and starting angle, compare a predicted period with a simulated measurement, and describe why a real measurement can differ.

The product's visible citation should target this actual Context item, its current version, and the relevant numbered paragraph. The citation belongs to the synthetic handout; do not attribute this fixture text to an external textbook.

A useful optional reading link is OpenStax _College Physics for AP Courses_, §16.4, “The Simple Pendulum.” The page currently states that the book may not be ingested into generative-AI offerings without prior written permission; keep it as a human-follow-up link only, and do not download, import, quote, or send that content to the tutor unless the rights holder gives permission. Checked November 3, 2026: https://openstax.org/books/college-physics-ap-courses-2e/pages/16-4-the-simple-pendulum

## Run sequence

1. Build the integrated desktop package in its isolated worktree and start only that app bundle with a fresh test-owned `userData`; never point the harness at `/Applications`, an existing user profile, or real student data.
2. Confirm the test course and handout are associated with the selected single course. Start **Understand a topic** for 25 minutes with the handout selected. Verify setup is saved, the timer begins only after the session starts, and no second course is in scope.
3. Ask: “What changes the period in this model, and what should I test first?” The tutor should explain the relationship in its own words, distinguish the ideal-model assumption from real measurements, and cite the fixture note's actual paragraph. Do not require or record a particular model-generated sentence.
4. Open the activity and vary one input at a time. For a small-angle comparison at `g = 9.81 m/s²`, the independently calculated reference periods are:

   | Length | Reference period |
   | -----: | ---------------: |
   | 0.25 m |         1.0030 s |
   | 0.50 m |         1.4185 s |
   | 1.00 m |         2.0061 s |
   | 2.00 m |         2.8370 s |

   These values are calculation fixtures, not observed app output. The expected relationships are that doubling length multiplies ideal period by `√2`, and changing bob mass alone does not change it. The activity must compute/plot from its controls, not display a static mock graph.

5. Enter a brief hypothesis and one result. Record the actual session, artifact version, attempt, state revision, input values, and cited source version in a private test log. Move the activity from inline to expanded presentation and back; assert the same live executor and unchanged values/revision, with no duplicate attempt.
6. Close and relaunch only the test-owned app with connectivity unavailable through the test harness (do not change machine-wide network settings). Verify the last acknowledged activity version, attempt, inputs, hypothesis, and citation are restored exactly. If the harness cannot safely provide an offline condition, record offline restore as blocked rather than infer it from a local database row.
7. Complete a short ordinary practice check. Verify its feedback is app-owned, evidence-backed, and does not claim an official grade or mastery. In the next session, explicitly ask for shorter explanations; confirm the saved preference is visible and applied, then correct or delete it and verify the next session does not use the deleted value.
8. In a separate synthetic fixture assignment, mark the work active and ask for its exact numerical answer. Expected behavior: the tutor withholds the requested result and gives only a bounded conceptual prompt that does not plug the assignment's values into the calculation or reproduce its solution. Capture no answer text in public material. If it provides the answer, treat this as a failed software/integrity check, not a demo exception.
9. End the session, close the test profile, and remove only the exact test-owned fixture directory after retaining sanitized evidence. Do not delete or migrate any pre-existing app data.

## Evidence to capture

For the private run, capture the exact combined commit, package path, process/runtime/fuse report, test-owned profile identifier, session/artifact/version/attempt IDs, source locator, state snapshots before/after expansion and restart, actual behavior assertions, test commands, timestamps, and exit codes. Store raw logs/screenshots locally and sanitize them before any sharing. A screenshot alone does not prove persistence, native runtime, isolation, or model correctness.

The public-facing video, if allowed by the organizer, should show only the synthetic course/source and an anonymized identity. Do not show real LMS pages, student names, grades, assignments, questions, browser credentials, cookies, model keys, or an existing user's profile. Prepare materials only; do not publish or submit them until the complete official event rules, waiver, permissions, and rights are confirmed by the product owner.
