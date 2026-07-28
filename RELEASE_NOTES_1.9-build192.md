# AnxOS Control Center v1.9-build192 - Private Alpha Release Candidate

Build 192 is an unpublished release candidate for signed in-place upgrade acceptance from Build 191.

## Fixed

- Fixed SSH lifecycle reporting so transport, authentication, permission, host-key, and remote-shell failures remain distinct.
- Added a bounded automatic retry when the authenticated remote shell is slow to start.
- Prevented renderer timing from replacing structured SSH failures with a generic timeout.
- Prevented Download Manager cards from exposing internal operation identifiers.
- Fixed Files workspace clipping at the standard desktop window size.
- Replaced repetitive Public Access loading fields with a grouped loading state.

## Added

- Added friendly Download Manager titles, provider badges, progress presentation, and expandable technical details.
- Added consistent status badge sizing and spacing across polished desktop surfaces.
- Added regression coverage for bounded SSH shell retry and structured failure categories.

## QA

- Upgrade an existing signed Build 191 installation without clearing its user profile or configuration.
- Verify existing nodes, credentials, Marketplace data, SSH profiles, Security state, and settings remain intact.
- Verify Marketplace, Download Manager, Files, Public Access, Docker, Instances, Agent compatibility, and SSH behavior.
- Verify Authenticode signing, signer identity, SHA-256, packaged Build 192 metadata, and source commit before publication.
- Do not publish this release candidate or create a final public tag.
