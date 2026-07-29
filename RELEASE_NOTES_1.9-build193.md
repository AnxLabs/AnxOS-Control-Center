# AnxOS Control Center v1.9 Build 193

Build 193 is a published Private Alpha focused on Marketplace reliability, unified server creation, operation visibility, notifications, and responsive desktop polish.

## Added

- Dedicated Marketplace and Create Server windows with a single guided creation workflow.
- Marketplace-to-Create Server handoff for catalog and provider-backed templates.
- Structured operation recovery and linked notification details.

## Fixed

- Restored CurseForge provider recovery and selected-Agent authentication fallback.
- Streamed large CurseForge server-pack downloads and extraction to prevent desktop memory exhaustion.
- Corrected ATM10 server-pack resolution using verified catalog metadata.
- Removed raw provider and operation identifiers from user-facing Download Manager content.
- Improved responsive layouts, overflow handling, loading states, and status badge consistency.

## QA

- Installed ATM10 through the normal Marketplace workflow on an existing remote node.
- Exercised Marketplace, Create Server, Download Manager, Notifications, Dashboard, Nodes, Instances, Docker, Files, Public Access, Security, Agent Control, and Settings with Computer Use.
- Validated signed in-place upgrade behavior, preserved user data and configuration, and verified the packaged application through Computer Use.

## Known Issues

- SSH connectivity is currently undergoing stabilization.
- Some SSH scenarios may authenticate but fail to open an interactive shell.
- SSH development is intentionally deferred to a future stabilization build.
