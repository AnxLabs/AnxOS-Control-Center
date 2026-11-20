# Page acceptance template (Build 216-A waves)

Copy this checklist into `docs/HANDOFF_BUILD216.md` for each page or wave.
A page is accepted only when every line is checked or explicitly waived by
the owner. Measurable lines come from `PLANS.md` section 3.

## Page: `<destination>` (wave `<A1…A10>`)

**Inventory rows:** `<n>` rows in `docs/anxhost/CAPABILITY_INVENTORY.md`
under this destination.

### Capability preservation

- [ ] Every inventory row for this destination is ticked `[x]` after being
      checked working (action, tab, input, dialog, IPC caller, template).
- [ ] IPC rows listed as "none found statically" for this area were checked
      by behaviour, not by grep.
- [ ] No backend, IPC, preload or Agent change, unless logic was moved to
      `src/shared` for this page (each moved function has a smoke).
- [ ] Security boundaries unchanged: actions still go through the same IPC
      handlers and permission checks; nothing relies on hiding a control.
- [ ] `npm run anxhost-capability-inventory:smoke` passes (hooks kept, or the
      inventory regenerated deliberately with the diff reviewed).
- [ ] `npm run frozen-identifiers:smoke` passes.

### Design

- [ ] Uses only `ahx-` patterns and `--ahx-*` tokens
      (`npm run anxhost-design-tokens:smoke` passes; no raw colours).
- [ ] Empty, loading, error and disabled states present, with a reason for
      each disabled action.
- [ ] Status shown with the eight-state status pattern (label always visible).
- [ ] Long operations use the operation tray or step list.
- [ ] Advanced options kept (moved into disclosures or dialogs, not removed).
- [ ] Keyboard: every control reachable, visible focus, dialogs trap focus
      and return it.

### Evidence

- [ ] Screenshots at 900x640, 1280x800 and 1920x1080 (dark) with no clipping,
      overflow, overlap or unreadable text; light theme checked once the
      light theme lands (A10).
- [ ] Page switch and cold start within the Build 215 baseline +10%
      (`docs/anxhost/baseline/BASELINE_215.md`), unless the owner approves.
- [ ] Ported and affected tests pass; each retired or rewritten test is
      listed with its replacement. No test weakened, skipped or loosened.
- [ ] `node --check` on changed JavaScript; `git diff --check` clean.
- [ ] Start and finish time, elapsed time and commits recorded.
