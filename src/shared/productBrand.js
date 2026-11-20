"use strict";

// AnxHost CC product names (Build 216, PLANS.md 216-0).
//
// The single source for user-visible product names from wave A1 on. Not used
// by the visible UI yet. Internal identifiers (appId, package names, the
// AnxHub data folder, anxos-agent, storage keys, headers) are NOT product
// names and must not be derived from these strings: see
// docs/anxhost/FROZEN_IDENTIFIERS.md.

(function attachProductBrand(root, factory) {
  const brand = factory();
  if (typeof module === "object" && module.exports) module.exports = brand;
  if (root) root.AnxProductBrand = brand;
})(typeof globalThis !== "undefined" ? globalThis : this, () => Object.freeze({
  productName: "AnxHost Control Center",
  shortName: "AnxHost CC",
  wordmark: "AnxHost",
  tagline: "Control Center",
  formerName: "AnxOS Control Center",
  formerlyLine: "Formerly AnxOS Control Center",
  // Saved display names equal to one of these are migrated to productName in
  // 216-B1; any other saved name is the user's own choice and is kept.
  legacyDefaultDisplayNames: Object.freeze(["AnxOS Control Center"]),
}));
