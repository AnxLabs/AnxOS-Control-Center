// The legacy origin stays trusted and serving for every installed build
// (sign-in, update fallback, downloads); it is frozen (FI-UPD-01).
const OFFICIAL_SITE_ORIGIN = "https://anxoscontrolcenter.org";
const OFFICIAL_SITE_HOSTNAME = "anxoscontrolcenter.org";

// 217-C: the primary website. The app opens account pages here; the website
// sends sign-in pages on to the legacy host until the account service trusts
// this origin, so both hosts must stay approved (FI-UPD-12).
const PRIMARY_SITE_ORIGIN = "https://anxhost.anxlabs.net";
const PRIMARY_SITE_HOSTNAME = "anxhost.anxlabs.net";

// Every host the app trusts for its own website. Host lists only grow.
const OFFICIAL_SITE_HOSTNAMES = Object.freeze([PRIMARY_SITE_HOSTNAME, OFFICIAL_SITE_HOSTNAME]);

module.exports = {
  OFFICIAL_SITE_ORIGIN,
  OFFICIAL_SITE_HOSTNAME,
  PRIMARY_SITE_ORIGIN,
  PRIMARY_SITE_HOSTNAME,
  OFFICIAL_SITE_HOSTNAMES,
};
