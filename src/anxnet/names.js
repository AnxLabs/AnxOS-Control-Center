"use strict";

// AnxNet names: memorable network names, device hostnames and service
// aliases under <network>.internal, with collision handling. Pure functions.

const crypto = require("crypto");

const WORDS = [
  "frost", "ember", "maple", "river", "cobalt", "aurora", "cedar", "comet", "delta", "falcon",
  "garnet", "harbor", "indigo", "juniper", "kestrel", "lagoon", "meadow", "nebula", "onyx", "pine",
  "quartz", "raven", "sable", "tundra", "umber", "violet", "willow", "zephyr", "basalt", "canyon",
];

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function randomInt(max) {
  return crypto.randomInt(0, max);
}

// "anx-frost72": short, readable, and checked against names already in use.
function generateNetworkName(taken = []) {
  const used = new Set(taken.map((name) => String(name).toLowerCase()));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const name = `anx-${WORDS[randomInt(WORDS.length)]}${randomInt(90) + 10}`;
    if (!used.has(name)) return name;
  }
  return `anx-${crypto.randomBytes(4).toString("hex")}`;
}

// A DNS label from any friendly name: lowercase letters, digits and dashes.
function toLabel(value, fallback = "device") {
  const label = String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return LABEL_PATTERN.test(label) ? label : fallback;
}

// The first free label: "desktop", then "desktop-2", "desktop-3", ...
function uniqueLabel(value, taken = [], fallback = "device") {
  const base = toLabel(value, fallback).slice(0, 28).replace(/-+$/g, "") || fallback;
  const used = new Set(taken.map((label) => String(label).toLowerCase()));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

function isValidNetworkName(name) {
  return /^anx-[a-z0-9-]{2,40}$/.test(String(name || "")) && LABEL_PATTERN.test(String(name));
}

function networkDomain(networkName) {
  return `${networkName}.internal`;
}

function deviceHostname(deviceLabel, networkName) {
  return `${deviceLabel}.${networkDomain(networkName)}`;
}

function serviceHostname(serviceLabel, deviceLabel, networkName) {
  return `${serviceLabel}.${deviceHostname(deviceLabel, networkName)}`;
}

// AnxNet addresses: 127.77.x.y from the device's roster slot (1-based). The
// whole 127/8 block is loopback on Windows and Linux, so each member's node
// can listen on a peer's address without touching routes. 127.77.0.1 is the
// node's own resolver.
function addressForSlot(slot) {
  const index = Number(slot) + 1;
  if (!Number.isInteger(index) || index < 2 || index > 65000) throw new Error("ANXNET_ADDRESS_SLOT_INVALID");
  return `127.77.${Math.floor(index / 256)}.${index % 256}`;
}

module.exports = {
  addressForSlot,
  deviceHostname,
  generateNetworkName,
  isValidNetworkName,
  networkDomain,
  serviceHostname,
  toLabel,
  uniqueLabel,
};
