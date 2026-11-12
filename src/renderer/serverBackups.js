// Phase 5: one server's backups, inline in its Backups tab. The data and every
// action come from the shared backup system in app.js (backupsState,
// refreshBackups, restoreSelectedBackup with its restore preview,
// verifyBackupIntegrity, downloadSelectedBackup); this file only lists the
// selected server's backups. Loaded after app.js.
(function () {
  "use strict";

  const list = document.querySelector("[data-server-backups]");
  const empty = document.querySelector("[data-server-backups-empty]");
  const status = document.querySelector("[data-server-backups-status]");
  const scheduleLine = document.querySelector("[data-server-backups-schedule]");
  if (!list) return;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function serverBackups() {
    const id = typeof selectedInstanceId === "string" ? selectedInstanceId : null;
    if (!id || typeof backupsState !== "object") return [];
    return (backupsState.backups || [])
      .filter((backup) => backup?.instanceId === id)
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  }

  function describeSchedule() {
    const id = typeof selectedInstanceId === "string" ? selectedInstanceId : null;
    const schedule = (backupsState.schedules || []).find((entry) => entry.instanceId === id && entry.enabled !== false);
    if (backupsState.scheduleSupported === false) return "This computer can't run scheduled backups.";
    if (!schedule) return "No automatic backups scheduled. Use Schedule to set them up.";
    const every = schedule.intervalHours ? `every ${schedule.intervalHours} h` : schedule.cron ? `on schedule ${schedule.cron}` : "on a schedule";
    const keep = schedule.keepLast ? `, keeping the last ${schedule.keepLast}` : "";
    return `Automatic backups ${every}${keep}.`;
  }

  async function act(kind, backup) {
    backupsState.selectedBackupId = backup.id;
    if (kind === "restore") await restoreSelectedBackup(backup);
    else if (kind === "verify") await verifyBackupIntegrity(backup.id);
    else if (kind === "download") await downloadSelectedBackup();
    render();
  }

  function row(backup) {
    const item = el("li", "addon-row server-backup-row");
    const iconBox = el("span", "addon-icon", backup.type === "world" ? "W" : "B");
    const text = el("div", "addon-row__text");
    text.append(
      el("strong", "", formatDateTime(backup.createdAt)),
      el("span", "addon-row__meta", [backup.type === "world" ? "World only" : "Whole server", formatBytes(Number(backup.size) || 0), backup.name && backup.name !== backup.id ? backup.name : null].filter(Boolean).join(" · ")),
    );
    const verification = el("span", "server-backup-verification");
    verification.append(createBackupVerificationPill(getBackupVerificationState(backup)));
    text.append(verification);
    const actions = el("div", "addon-row__actions");
    const button = (label, kind, primary) => {
      const node = el("button", `inline-action${primary ? " instance-action--primary" : ""}`, label);
      node.type = "button";
      node.disabled = kind === "verify" && backupVerificationInFlight.has(backup.id);
      if (kind === "verify" && node.disabled) node.textContent = "Verifying…";
      node.addEventListener("click", () => act(kind, backup));
      return node;
    };
    actions.append(button("Restore", "restore", true), button("Verify", "verify"), button("Download", "download"));
    item.append(iconBox, text, actions);
    return item;
  }

  function render() {
    const backups = serverBackups();
    const loading = typeof backupRequestInFlight === "boolean" && backupRequestInFlight;
    list.replaceChildren(...backups.slice(0, 50).map(row));
    if (empty) empty.hidden = backups.length > 0 || loading;
    if (status) status.textContent = loading ? "Loading…" : backupsState.connected === false && backupsState.error ? "Unavailable" : `${backups.length} backup${backups.length === 1 ? "" : "s"}`;
    if (scheduleLine) scheduleLine.textContent = backupsState.connected === false && backupsState.error ? backupsState.error : describeSchedule();
  }

  async function refresh() {
    render();
    if (typeof refreshBackups === "function") await refreshBackups();
    render();
  }

  window.AnxServerBackups = { refresh, render };
})();
