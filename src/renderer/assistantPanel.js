// Phase X: the optional assistant panel.
//
// Hidden unless an Owner turned AI assistance on. Everything shown here comes
// from the main process; text is always inserted with textContent, because
// answers quote log lines and other untrusted data. Approving sends only the
// proposal id and its digest; the main process holds the exact action.
(function assistantPanel() {
  "use strict";

  const api = window.anxos && window.anxos.ai;
  const panel = document.querySelector("[data-assistant-panel]");
  const openButton = document.querySelector("[data-assistant-open]");
  if (!api || !panel || !openButton) return;

  const log = panel.querySelector("[data-assistant-log]");
  const form = panel.querySelector("[data-assistant-form]");
  const input = panel.querySelector("[data-assistant-input]");
  const askButton = panel.querySelector("[data-assistant-ask]");
  const stopButton = panel.querySelector("[data-assistant-stop]");
  const contextLabel = panel.querySelector("[data-assistant-context]");
  const providerLabel = panel.querySelector("[data-assistant-provider]");
  let busy = false;

  const FRESHNESS_LABEL = { live: "Live", cached: "Recent", stale: "Stale", unavailable: "Unavailable" };
  const STATE_LABEL = {
    awaiting_approval: "Awaiting approval", authorized: "Authorized", running: "Running", succeeded: "Succeeded",
    failed: "Failed", verification_unavailable: "Ran, not verified", rejected: "Rejected", expired: "Expired",
    cancelled: "Cancelled", interrupted: "Interrupted",
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function settings() {
    try { return typeof getCurrentSettings === "function" ? getCurrentSettings() : {}; } catch { return {}; }
  }

  function enabled() {
    return settings()["ai.enabled"] === true;
  }

  function selection() {
    let nodeId = null;
    try { nodeId = typeof getSelectedNodeId === "function" ? getSelectedNodeId() : null; } catch { nodeId = null; }
    let instanceId = null;
    try { instanceId = typeof selectedInstanceId === "string" ? selectedInstanceId : null; } catch { instanceId = null; }
    return { selectedNodeId: nodeId, selectedInstanceId: instanceId };
  }

  function describeSelection() {
    const { selectedNodeId, selectedInstanceId } = selection();
    let instanceName = null;
    try {
      const instance = selectedInstanceId && typeof findInstance === "function" ? findInstance(selectedInstanceId) : null;
      instanceName = instance ? (instance.displayName || instance.name || instance.id) : null;
    } catch { instanceName = null; }
    const parts = [];
    let nodeName = null;
    try { const node = typeof getSelectedNode === "function" ? getSelectedNode() : null; nodeName = node ? (node.displayName || node.name || null) : null; } catch { nodeName = null; }
    if (selectedNodeId) parts.push(`Computer: ${nodeName || selectedNodeId}`);
    if (instanceName) parts.push(`Server: ${instanceName}`);
    return parts.length ? `Looking at ${parts.join(" · ")}. Say "this server" to use it.` : "No computer selected.";
  }

  function syncVisibility() {
    const on = enabled();
    openButton.hidden = !on;
    if (!on && !panel.hidden) close();
    const provider = settings()["ai.provider"] || "deterministic";
    if (providerLabel) providerLabel.textContent = provider === "ollama" ? `Local model: ${settings()["ai.ollamaModel"] || "not chosen"}` : provider === "sona" ? "Sona (not connected yet)" : "Built-in (no model)";
  }

  function open() {
    if (!enabled()) return;
    panel.hidden = false;
    openButton.setAttribute("aria-expanded", "true");
    if (contextLabel) contextLabel.textContent = describeSelection();
    if (!log.childElementCount) {
      log.append(el("p", "assistant-hint", "Ask about your computers, servers, Docker or networking. Nothing changes unless you approve it."));
    }
    input.focus();
  }

  function close() {
    panel.hidden = true;
    openButton.setAttribute("aria-expanded", "false");
  }

  function setBusy(value) {
    busy = value;
    askButton.disabled = value;
    stopButton.hidden = !value;
    input.disabled = value;
  }

  function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
  }

  function errorText(error) {
    if (typeof normalizeIpcErrorMessage === "function") return normalizeIpcErrorMessage(error, "The assistant could not answer.");
    return error?.message || "The assistant could not answer.";
  }

  function renderObservations(card, observations) {
    const shown = (observations || []).filter((entry) => entry && entry.label).slice(0, 12);
    if (!shown.length) return;
    const list = el("ul", "assistant-facts");
    for (const entry of shown) {
      const item = el("li", "assistant-fact");
      const value = entry.value === null || entry.value === undefined ? "—" : `${entry.value}${entry.unit || ""}`;
      item.append(el("span", "assistant-fact__label", entry.label), el("strong", "assistant-fact__value", value));
      const badge = el("span", `assistant-badge assistant-badge--${entry.freshness}`, FRESHNESS_LABEL[entry.freshness] || entry.freshness);
      badge.title = entry.observedAt ? `Measured ${entry.observedAt}${entry.note ? ` · ${entry.note}` : ""}` : (entry.note || "No measurement");
      item.append(badge);
      list.append(item);
    }
    card.append(list);
  }

  function renderFindings(card, findings) {
    for (const finding of findings || []) {
      const box = el("section", "assistant-finding");
      const head = el("div", "assistant-finding__head");
      head.append(el("strong", null, finding.problem), el("span", `assistant-badge assistant-badge--confidence-${finding.confidence}`, `${finding.confidence} confidence`));
      box.append(head);
      if (finding.explanation) box.append(el("p", null, finding.explanation));
      if (Array.isArray(finding.evidence) && finding.evidence.length) {
        const evidence = el("div", "assistant-evidence");
        evidence.append(el("span", "assistant-evidence__label", "Evidence"));
        for (const item of finding.evidence) {
          const quote = el("code", null, item.text);
          quote.title = item.source || "";
          evidence.append(quote);
        }
        box.append(evidence);
      }
      const facts = el("dl", "assistant-finding__facts");
      for (const [label, value] of [["Suggested fix", finding.suggestedFix], ["Impact", finding.impact], ["How to check", finding.verification]]) {
        if (!value) continue;
        facts.append(el("dt", null, label), el("dd", null, value));
      }
      box.append(facts);
      if (finding.repair && finding.repair.tool && finding.repair.target) {
        const button = el("button", "inline-action", `Prepare: ${finding.repair.label || finding.repair.tool}`);
        button.type = "button";
        button.addEventListener("click", () => prepareRepair(finding.repair, button));
        box.append(button);
      }
      card.append(box);
    }
  }

  function renderList(card, title, lines, className) {
    const items = (lines || []).filter(Boolean);
    if (!items.length) return;
    const wrap = el("div", className);
    wrap.append(el("span", "assistant-list__title", title));
    const list = el("ul");
    for (const line of items.slice(0, 20)) list.append(el("li", null, line));
    wrap.append(list);
    card.append(wrap);
  }

  function renderProposal(card, proposal) {
    const box = el("section", "assistant-proposal");
    box.dataset.proposalId = proposal.id;
    box.append(el("span", "assistant-list__title", "Proposed change — needs your approval"));
    box.append(el("strong", "assistant-proposal__summary", proposal.preview?.summary || proposal.tool));
    const facts = el("dl", "assistant-finding__facts");
    facts.append(el("dt", null, "Target"), el("dd", null, `${proposal.preview?.targetLabel || ""} (${[proposal.target?.nodeId, proposal.target?.instanceId || proposal.target?.container].filter(Boolean).join(" / ")})`));
    facts.append(el("dt", null, "Impact"), el("dd", null, proposal.preview?.impact || ""));
    facts.append(el("dt", null, "Checked afterwards"), el("dd", null, proposal.preview?.verification || ""));
    box.append(facts);
    for (const warning of proposal.preview?.warnings || []) box.append(el("p", "assistant-warning", warning));
    const status = el("p", "assistant-proposal__status", `Expires at ${new Date(proposal.expiresAt).toLocaleTimeString()}.`);
    const actions = el("div", "assistant-actions");
    const approve = el("button", "primary-button", "Approve…");
    approve.type = "button";
    const reject = el("button", "inline-action", "Reject");
    reject.type = "button";
    approve.addEventListener("click", () => approveProposal(proposal, { approve, reject, status }));
    reject.addEventListener("click", async () => {
      approve.disabled = true;
      reject.disabled = true;
      try {
        await api.reject(proposal.id);
        status.textContent = "Rejected. Nothing was changed.";
      } catch (error) {
        status.textContent = errorText(error);
      }
    });
    actions.append(approve, reject);
    box.append(actions, status);
    card.append(box);
  }

  async function approveProposal(proposal, { approve, reject, status }) {
    const lines = [proposal.preview?.summary, `Target: ${proposal.preview?.targetLabel || ""}`, proposal.preview?.impact].filter(Boolean).join("\n");
    const confirmed = typeof createSecurityConfirmation === "function"
      ? await createSecurityConfirmation({ title: "Approve this change?", message: lines, note: (proposal.preview?.warnings || []).join(" "), confirmLabel: "Approve and run" })
      : window.confirm(lines);
    if (!confirmed) return;
    approve.disabled = true;
    reject.disabled = true;
    status.textContent = "Running…";
    let operationId = null;
    try {
      if (typeof startOperation === "function") operationId = startOperation({ type: "Assistant", title: proposal.preview?.summary || proposal.tool, target: proposal.preview?.targetLabel || "", step: "Approved; running" });
    } catch { operationId = null; }
    try {
      const outcome = await api.approve(proposal.id, proposal.digest);
      const label = STATE_LABEL[outcome.state] || outcome.state;
      status.textContent = `${label}. ${outcome.result?.message || ""}`.trim();
      status.dataset.state = outcome.state;
      if (operationId && typeof updateOperation === "function") {
        if (outcome.state === "succeeded") finishOperation(operationId, true, outcome.result?.message || "Succeeded");
        else if (outcome.state === "verification_unavailable") updateOperation(operationId, { status: "completed", step: `Ran, but NOT verified: ${outcome.result?.message || ""}` });
        else finishOperation(operationId, false, outcome.result?.message || label);
      }
      if (typeof showToast === "function") showToast(status.textContent, outcome.state === "succeeded" ? null : "warning");
    } catch (error) {
      status.textContent = errorText(error);
      status.dataset.state = "failed";
      if (operationId && typeof finishOperation === "function") finishOperation(operationId, false, status.textContent);
    }
  }

  function renderSetupPlan(card, plan) {
    const box = el("section", "assistant-proposal assistant-proposal--plan");
    box.append(el("span", "assistant-list__title", "Server plan — nothing is created yet"));
    const facts = el("dl", "assistant-finding__facts");
    for (const [label, value] of [["Game", plan.game], ["Players", plan.players], ["Runtime", `${plan.runtime} — ${plan.runtimeReason}`], ["Memory", `${plan.memoryGb} GB`], ["Disk", `about ${plan.diskGb} GB`], ["Computer", plan.computerLabel || "none has clear room"]]) {
      facts.append(el("dt", null, label), el("dd", null, value));
    }
    box.append(facts);
    const button = el("button", "primary-button", "Open Create Server");
    button.type = "button";
    button.addEventListener("click", () => {
      if (typeof openCreateServerWorkspace === "function") openCreateServerWorkspace(null);
      if (typeof showToast === "function") showToast(`Plan: ${plan.game}, ${plan.runtime}, ${plan.memoryGb} GB${plan.computerLabel ? ` on ${plan.computerLabel}` : ""}. You accept the EULA in the wizard.`);
      close();
    });
    box.append(button);
    card.append(box);
  }

  function renderClarification(card, clarification, question) {
    const box = el("div", "assistant-actions assistant-actions--wrap");
    for (const option of clarification.options || []) {
      const button = el("button", "inline-action", option.label);
      button.type = "button";
      button.addEventListener("click", () => {
        if (!option.target?.nodeId) return;
        ask(`${question} (this one)`, { selectedNodeId: option.target.nodeId, selectedInstanceId: option.target.instanceId || null });
      });
      box.append(button);
    }
    card.append(box);
  }

  function renderResponse(response, question) {
    const card = el("article", "assistant-message assistant-message--answer");
    if (response.target?.label) card.append(el("span", "assistant-target", `Target: ${response.target.label}`));
    card.append(el("p", "assistant-answer", response.answer));
    if (response.refused) card.classList.add("assistant-message--refused");
    if (response.clarification) renderClarification(card, response.clarification, question);
    renderObservations(card, response.observations);
    renderFindings(card, response.findings);
    if (response.setupPlan) renderSetupPlan(card, response.setupPlan);
    if (response.proposal) renderProposal(card, response.proposal);
    renderList(card, "Not known", response.missing, "assistant-list assistant-list--missing");
    if (response.modelSummary) {
      const summary = el("div", "assistant-model-summary");
      summary.append(el("span", "assistant-list__title", `Model summary (${response.provider?.model || "model"}) — may be imperfect; the facts above are the record`), el("p", null, response.modelSummary));
      card.append(summary);
    }
    if (response.details?.length) {
      const details = el("details", "assistant-details");
      details.append(el("summary", null, "Technical details"));
      const list = el("ul");
      for (const line of response.details.slice(0, 30)) list.append(el("li", null, line));
      details.append(list);
      card.append(details);
    }
    card.append(el("small", "assistant-meta", `${response.provider?.used ? `Model: ${response.provider.model || response.provider.id}` : "Answered from measurements"} · ${new Date(response.answeredAt).toLocaleTimeString()}`));
    log.append(card);
    scrollToEnd();
  }

  async function prepareRepair(repair, button) {
    button.disabled = true;
    try {
      const response = await api.proposeRepair(repair.tool, repair.target);
      renderResponse(response, repair.label || repair.tool);
    } catch (error) {
      log.append(el("p", "assistant-message assistant-message--error", errorText(error)));
      button.disabled = false;
    }
  }

  async function ask(question, contextOverride = null) {
    const text = String(question || "").trim();
    if (!text || busy) return;
    log.append(el("p", "assistant-message assistant-message--question", text));
    scrollToEnd();
    setBusy(true);
    try {
      const response = await api.ask(text, contextOverride || selection());
      renderResponse(response, text);
    } catch (error) {
      log.append(el("p", "assistant-message assistant-message--error", errorText(error)));
    } finally {
      setBusy(false);
      input.value = "";
      input.focus();
    }
  }

  async function showHistory() {
    try {
      const { operations } = await api.history();
      const card = el("article", "assistant-message assistant-message--answer");
      card.append(el("p", "assistant-answer", operations.length ? "Recent assistant operations:" : "No assistant operations yet."));
      const list = el("ul", "assistant-history");
      for (const entry of operations.slice(0, 15)) {
        list.append(el("li", null, `${new Date(entry.updatedAt).toLocaleString()} · ${entry.preview?.summary || entry.tool} · ${STATE_LABEL[entry.state] || entry.state}${entry.result?.message ? ` — ${entry.result.message}` : ""}`));
      }
      card.append(list);
      log.append(card);
      scrollToEnd();
    } catch (error) {
      log.append(el("p", "assistant-message assistant-message--error", errorText(error)));
    }
  }

  openButton.addEventListener("click", () => (panel.hidden ? open() : close()));
  panel.querySelector("[data-assistant-close]")?.addEventListener("click", close);
  panel.querySelector("[data-assistant-history]")?.addEventListener("click", showHistory);
  stopButton.addEventListener("click", () => { api.cancel().catch(() => {}); });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    ask(input.value);
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  // Settings: "Test provider".
  const testButton = document.querySelector("[data-ai-provider-test]");
  const testStatus = document.querySelector("[data-ai-provider-status]");
  testButton?.addEventListener("click", async () => {
    testButton.disabled = true;
    if (testStatus) testStatus.textContent = "Checking…";
    try {
      const health = await api.testProvider();
      if (testStatus) {
        testStatus.textContent = health.available
          ? `Available${health.version ? ` (Ollama ${health.version})` : ""} on ${health.host || "this PC"}${health.model ? `, model ${health.model}` : ""}.`
          : `Not available: ${health.reason || "unknown reason"}${Array.isArray(health.models) && health.models.length ? ` Installed models: ${health.models.slice(0, 8).join(", ")}.` : ""}`;
        testStatus.dataset.state = health.available ? "ok" : "warning";
      }
    } catch (error) {
      if (testStatus) { testStatus.textContent = errorText(error); testStatus.dataset.state = "warning"; }
    } finally {
      testButton.disabled = false;
    }
  });

  syncVisibility();
  // Settings change through the normal Settings page; a light check keeps the
  // button in step without touching the settings code.
  setInterval(syncVisibility, 1500);
})();
