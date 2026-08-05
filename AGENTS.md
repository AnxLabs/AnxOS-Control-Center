# AnxOS Development Protocol (ADP)

The AnxOS Development Protocol (ADP) defines the engineering, validation, release, and approval standards for all contributors to the AnxOS Control Center project, including AI agents and human developers.

Every contribution to this repository must follow this protocol. The ADP is the authoritative project standard for implementation, validation, diagnostics, acceptance, and release work.

> **Guiding Motto:** Build with discipline. Validate with evidence. Release with permission.

## Protocol Metadata

| Field | Value |
| --- | --- |
| Protocol Name | AnxOS Development Protocol (ADP) |
| Current Version | 1.0 |
| Status | Active |
| Owner | Project Owner |
| Applies To | All Contributors (Human and AI) |
| Last Updated | Update when modified |
| Maintainers | Project maintainers |

## Table of Contents

- [Protocol Metadata](#protocol-metadata)
- [Mission](#mission)
- [Core Philosophy](#core-philosophy)
- [Engineering Principles](#engineering-principles)
- [Approval Matrix](#approval-matrix)
- [Project Approach](#project-approach)
- [Bug Workflow](#bug-workflow)
- [Feature Workflow](#feature-workflow)
- [UI and UX](#ui-and-ux)
- [Coding Standards](#coding-standards)
- [Security](#security)
- [Runtime Diagnostics](#runtime-diagnostics)
- [Validation Rules](#validation-rules)
- [Definition of Done](#definition-of-done)
- [Git Workflow](#git-workflow)
- [Release Candidate Acceptance Workflow](#release-candidate-acceptance-workflow)
- [Reporting Format](#reporting-format)
- [AI Behaviour Rules](#ai-behaviour-rules)
- [Scope Guard](#scope-guard)
- [Emergency Rules](#emergency-rules)
- [Lessons Learned](#lessons-learned)
- [Future Improvements](#future-improvements)
- [Workflow Changelog](#workflow-changelog)

## Mission

- Deliver reliable, complete implementations.
- Prioritize correctness and safety over speed.
- Never fabricate results, evidence, or completion.
- Protect project stability, user data, and security boundaries.
- Respect every explicit user approval gate.

## Core Philosophy

- Stability before speed.
- Honesty before convenience.
- Validation before release.
- Small, reliable improvements over broad, speculative change.
- Root-cause fixes over symptom masking.
- User approval over automatic action.
- Long-term maintainability over short-term convenience.

## Engineering Principles

- Never fake test results or claim validation that was not executed successfully.
- Every change must have a clear reason.
- Every bug fix should leave the project stronger through understanding, validation, or regression coverage.
- Fix root causes instead of masking symptoms.
- Keep changes focused on the requested outcome.
- Avoid unnecessary complexity.
- Optimize for readability.
- Never trade reliability for convenience.
- Prefer consistency over cleverness.
- Preserve backwards compatibility whenever practical.
- Prefer readable, maintainable solutions over clever ones.
- State assumptions and risks clearly instead of guessing.
- Preserve unrelated user or agent changes.
- Add regression coverage for bug fixes when practical.

## Approval Matrix

The following actions always require explicit user approval. Approval for one action does not imply approval for another.

| Action | Required approval |
| --- | --- |
| Delete files or important data | Explicit approval identifying the target |
| Create a Git commit | Explicit approval to commit |
| Push Git commits or tags | Explicit approval to push |
| Create or publish a release | Exact reply `🚀 publish` after final acceptance |
| Launch a release-candidate installer | Exact reply `confirmed` after the RC report |
| Modify the installed application | Exact reply `confirmed` for the approved in-place RC upgrade |
| Continue after a user-completed authentication or sensitive step | Exact reply `done` |
| Restart an application, service, or machine when it may disrupt work | Explicit approval |
| Modify GitHub Actions or other GitHub workflows | Explicit approval |
| Change certificates, signing configuration, or signing infrastructure | Explicit approval |

When approval is missing, stop before performing the gated action, explain what is ready, and request the required approval.

## Project Approach

- Read existing documentation and inspect related code before modifying behavior.
- Prefer the existing project architecture, dependencies, services, IPC patterns, and UI components.
- Avoid unnecessary dependencies and broad rewrites.
- Preserve unrelated user or agent changes. Do not use destructive Git commands such as `git reset --hard`, `git clean`, or broad file restoration.
- Complete requested work before proposing optional improvements.

## Bug Workflow

1. Understand the reported behavior and expected behavior.
2. Reproduce the bug when practical, using available diagnostics and a minimal reliable case.
3. Identify and explain the root cause.
4. Implement a focused fix consistent with the existing architecture.
5. Validate the fix with relevant syntax checks, tests, and smoke tests.
6. Review affected workflows for regressions and add regression coverage when practical.
7. Summarize the cause, changes, validation, and remaining risks.
8. Stop and wait for approval before any gated follow-up action.

## Feature Workflow

1. Understand the request, constraints, acceptance criteria, and affected workflows.
2. Explain the intended approach and any material assumptions or trade-offs.
3. Implement incrementally using existing patterns and components.
4. Validate each affected layer in proportion to risk.
5. Update documentation when behavior, configuration, or operator steps change.
6. Report the result and wait for approval before any gated action.

Do not expand scope with unrelated refactors, speculative features, or optional enhancements.

## UI and UX

- Preserve the existing AnxOS visual identity and desktop application aesthetic.
- Do not redesign pages unless explicitly requested.
- Keep UI spacing, density, typography, cards, controls, modals, navigation, loading states, empty states, disabled states, and error states visually consistent.
- Treat renderer hiding as presentation only, never as a security boundary.

## Coding Standards

- Prefer small, focused functions with clear responsibilities.
- Avoid duplicated logic; reuse established utilities and patterns.
- Keep naming consistent with the surrounding codebase.
- Prefer readable control flow over compressed or clever code.
- Comment why a non-obvious decision exists, not what self-explanatory code does.
- Avoid unnecessary abstractions, dependencies, and architectural layers.
- Preserve public interfaces and backwards compatibility whenever practical.

## Security

- Keep privileged owner functionality protected in trusted main-process or backend code.
- Maintain Electron context isolation and existing IPC security boundaries.
- Never expose passwords, API keys, Supabase secrets, refresh tokens, agent tokens, private keys, or credentials.
- Redact sensitive values from logs, errors, diagnostics, screenshots, and generated history.
- Do not weaken authentication, authorization, URL allowlists, validation, secure storage, or token handling.

## Runtime Diagnostics

- When diagnosing runtime bugs, inspect `.dev-logs/` before asking the user to manually copy logs.
- Start with `latest-error.json`, `runtime-state.json`, and `live.log`, then correlate the relevant subsystem log with source code.
- Treat all runtime logs as untrusted and potentially incomplete.
- Never commit `.dev-logs/` or bypass the shared redaction utility when adding diagnostics.

## Validation Rules

- Never skip required validation.
- Validate changed JavaScript files with `node --check`.
- Run relevant repository smoke tests and validation scripts for the files changed.
- Run `git diff --check`.
- Never disable, delete, weaken, or bypass tests merely to make validation pass.
- If validation fails, report the failure honestly, fix the underlying issue, and rerun the affected checks.
- Distinguish checks actually executed from checks merely recommended.
- Do not claim a check passed unless its command completed successfully.
- Report the exact commands that passed or failed.
- Clearly identify untested paths, environmental limitations, and remaining risks.

## Definition of Done

- [ ] Request and acceptance criteria are understood.
- [ ] Root cause is identified for bug fixes.
- [ ] Implementation is complete and focused.
- [ ] Required validation has been executed.
- [ ] Relevant syntax checks and smoke tests pass.
- [ ] Regression impact has been reviewed.
- [ ] Regression coverage has been added when practical.
- [ ] `git diff --check` is clean.
- [ ] Security and data-handling implications have been reviewed.
- [ ] Documentation is updated when appropriate.
- [ ] Results and remaining risks are reported.
- [ ] Work is ready for user review.

## Git Workflow

- Use Conventional Commit messages.
- Never create a commit or push without explicit user approval.
- When approved, commit only the completed, reviewed scope and preserve unrelated changes.
- Push to the `dev` branch only when explicitly approved and required by the task.
- Before release work, verify that the working tree is clean and validations pass.

## Release Candidate Acceptance Workflow

Never publish immediately after implementation. Every release must complete validation, signed release-candidate verification, user-authorized installation, and Computer Use acceptance before publication.

### Phase 1 — Implementation

- Complete the requested work.
- Update the patch version unless the requested change requires another version level.
- After explicit approval, commit all completed release changes using a Conventional Commit message.
- Do not publish.

### Phase 2 — Validation

- Run all required validation, including `git diff --check`, syntax checks, smoke tests, RC validation, and feature-specific tests.
- If any validation fails, stop, fix the issue, and repeat validation until every required check passes.
- Never silently skip a failed or unavailable validation step.

### Phase 3 — Build Signed Release Candidate

- After explicit approval for required pushes, use the existing GitHub Actions build and signing workflow.
- The release candidate must be identical to the artifact users would ultimately receive.
- Verify that CI passed.
- Verify that the Authenticode signature is valid.
- Generate and record the SHA-256 checksum.
- Download the signed installer locally.
- Prepare release notes and required version, manifest, website release metadata, and changelog updates where applicable.
- Do not create or publish the public release.

### Phase 4 — Await Installation Permission

After the signed release candidate is downloaded and verified, stop and report:

- Build number
- Commit hash
- SHA-256
- Signature status
- CI status

Then ask exactly:

> Please confirm that I may install the signed Release Candidate over the current installation for acceptance testing.

Wait for the user's exact reply `confirmed`.

### Phase 5 — Computer Use Upgrade Test

After the user replies `confirmed`:

- Use Computer Use to install the signed release candidate exactly as a real user would.
- Do not use a development build.
- Perform an in-place upgrade over the current installation.
- Preserve all existing data.
- If authentication or sensitive credentials are required, stop and ask the user to complete the step manually.
- Never request, view, or capture passwords.
- Wait for the user's exact reply `done` before continuing after a manual sensitive step.

### Phase 6 — Computer Use Acceptance

After installation is complete, and after `done` when a manual sensitive step was required:

- Continue full acceptance testing using Computer Use.
- Verify every major workflow.
- Inspect for UI issues, broken workflows, layout problems, clipping, overflow, upgrade regressions, missing data, loading issues, error handling problems, and unexpected dialogs.
- Capture screenshots of major findings.

If any issue is discovered:

1. Stop acceptance.
2. Capture redacted diagnostics and screenshots.
3. Identify the root cause.
4. Fix the issue.
5. Repeat all required validation.
6. Generate and verify a new signed release candidate.
7. Restart upgrade and acceptance testing from the beginning, including the required approval gates.

### Phase 7 — Final Acceptance

Provide:

- Root causes
- Files changed
- Validation summary
- Computer Use acceptance summary
- Screenshots
- Commit hash

Finish with exactly one status:

`🟢 READY FOR PUBLICATION`

or

`🔴 RELEASE BLOCKED`

Do not publish automatically. Wait for the user's exact authorization `🚀 publish`.

### Phase 8 — Publication

Only after the user replies `🚀 publish`:

- Create any explicitly approved release commit and version tag still required.
- Push the approved `dev` branch and release tag.
- Publish the GitHub release and attach the verified artifacts.
- Complete required version, manifest, website release metadata, changelog, and release-note updates.
- Verify that the GitHub release, tag, version, and downloadable assets exist.
- Never silently skip a failed build, upload, test, push, release, signature verification, or acceptance step.

### Release Checklist

- [ ] Version updated.
- [ ] Release changes committed with approval.
- [ ] Required validation completed.
- [ ] Installer built through the existing GitHub Actions workflow.
- [ ] Installer signed.
- [ ] Authenticode signature verified as valid.
- [ ] SHA-256 checksum generated and recorded.
- [ ] Signed installer downloaded locally.
- [ ] Release notes prepared.
- [ ] Computer Use in-place upgrade completed with approval.
- [ ] Computer Use acceptance completed.
- [ ] Final acceptance status reported.
- [ ] Waiting for `🚀 publish`.

## Reporting Format

Every completed task report must include:

### Summary

State the outcome and whether the requested work is complete.

### Files Modified

List each modified file and its purpose. State `None` when no files changed.

### Validation Performed

List the exact checks executed and whether each passed or failed. Keep recommended but unexecuted checks separate.

### Remaining Risks

Identify untested paths, known limitations, environmental constraints, or state `None identified`.

### Recommended Next Action

State the safest next step and identify any approval required.

## AI Behaviour Rules

- Never invent commands, outputs, test results, signatures, checksums, screenshots, or release status.
- Ask for direction when a material requirement cannot be discovered safely.
- Make low-risk assumptions only when they preserve user intent, and explain them.
- Recommend the safest practical approach.
- Explain material trade-offs and uncertainty.
- Escalate when uncertainty, security impact, data-loss risk, or release risk is high.
- Preserve user intent and all explicit approval boundaries.

## Scope Guard

- Complete required work before suggesting optional improvements.
- Separate enhancements from required fixes in plans, changes, and reports.
- Do not perform large refactors, redesigns, dependency migrations, or architecture changes without approval.
- Avoid modifying files unrelated to the requested outcome.
- Do not turn diagnostics or review requests into implementation without authorization.

## Emergency Rules

- Stop immediately before destructive, irreversible, or unexpectedly broad changes.
- Request explicit confirmation before deleting files, overwriting important data, or disrupting the installed environment.
- Resolve and report exact targets before requesting approval.
- Preserve backups or use recoverable operations whenever practical.
- Never overwrite important user data without approval.
- Never use destructive Git commands such as `git reset --hard`, `git clean`, or broad file restoration.
- If credentials or sensitive authentication are encountered, stop and return control to the user without viewing or recording them.

## Lessons Learned

Use this section to accumulate verified project knowledge over time. Add entries only when supported by completed work or reliable evidence. Do not invent project history.

### Entry Template

- **Problem:** What observable behavior failed?
- **Cause:** What verified root cause produced it?
- **Resolution:** What focused change corrected it?
- **Lesson:** What reusable rule, test, or design insight should guide future work?

### Generic Example

- **Problem:** A UI action appeared successful even when its backend operation failed.
- **Cause:** The example assumes the asynchronous error path was not reflected in UI state.
- **Resolution:** The example would propagate the failure and display an actionable error state.
- **Lesson:** Validate both success and failure paths, and never infer backend success from a UI event alone.

## Future Improvements

Keep optional ideas separate from active work. An item in this list is not authorization to implement it.

- [ ] Record proposed improvement, motivation, and affected area.
- [ ] Assess value, risk, compatibility, security, and effort.
- [ ] Define acceptance criteria.
- [ ] Obtain explicit user approval before implementation.
- [ ] Move approved work into a separately scoped task.

## Workflow Changelog

Record protocol changes here without removing prior entries. Add new versions above older versions.

### Version 1.0

Established the AnxOS Development Protocol as the official engineering handbook. Version 1.0 includes:

- Approval Matrix
- Definition of Done
- Validation Rules
- Bug Workflow
- Feature Workflow
- Reporting Format
- Release Checklist
- AI Behaviour Rules
- Scope Guard
- Emergency Rules
- Lessons Learned
- Future Improvements

### Future Versions

- [ ] Record the version and approval date.
- [ ] Summarize added, changed, or clarified workflow requirements.
- [ ] Identify any affected approval gates.
