"use strict";

// Phase X: deterministic understanding of everyday questions.
//
// parseIntent() maps English to one of a fixed set of intents without a
// model, so the assistant works with AI providers off or unavailable.
// resolveTarget() picks the computer or server the question is about, by
// stable id. It never guesses: several matches ask the user to choose, and an
// offline computer is reported, never swapped for another one.

const GAMES = ["minecraft", "palworld", "valheim", "terraria", "rust", "fivem", "hytale"];

function lower(text) {
  return String(text || "").toLowerCase();
}

function has(text, pattern) {
  return pattern.test(text);
}

function detectGame(text) {
  return GAMES.find((game) => new RegExp(`\\b${game}\\b`).test(text)) || null;
}

function detectPlayers(text) {
  const match = text.match(/\b(\d{1,3})\s*(?:friends|players|people|users)\b/) || text.match(/\bfor\s+(\d{1,3})\b/);
  if (match) return Math.min(200, Math.max(1, Number(match[1])));
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, fifty: 50 };
  const word = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|fifty)\s+(?:friends|players|people)\b/);
  return word ? words[word[1]] : null;
}

// Returns { intent, stateChanging, ... }. Order matters: actions first, so
// "restart my minecraft server because it crashed" is an action, not a
// diagnosis.
function parseIntent(question) {
  const text = lower(question).replace(/[’']/g, "'").trim();
  if (!text) return { intent: "empty", stateChanging: false };

  const action = text.match(/^(?:please\s+|can you\s+|could you\s+)?(start|stop|restart|reboot|back ?up|backup)\b/)
    || text.match(/\b(?:please|can you|could you)\s+(start|stop|restart|reboot|back ?up|backup)\b/);
  if (action) {
    const verb = action[1].replace(/\s+/g, "");
    if (/\bcontainer\b/.test(text) && (verb === "restart" || verb === "reboot")) {
      return { intent: "action", stateChanging: true, tool: "docker.container.restart" };
    }
    if (verb === "backup") return { intent: "action", stateChanging: true, tool: "backup.create", args: { type: /\bworld\b/.test(text) ? "world" : "full" } };
    if (/\b(computer|pc|machine|node|host)\b/.test(text) && !/\bserver\b/.test(text)) {
      return { intent: "unsupported_action", stateChanging: true, reason: "Restarting or shutting down a whole computer is not something the assistant does. Use the computer itself." };
    }
    const tool = verb === "reboot" ? "server.restart" : `server.${verb}`;
    return { intent: "action", stateChanging: true, tool };
  }

  if (has(text, /\b(delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|wip(?:e|es|ed|ing)|eras(?:e|es|ed|ing)|uninstall(?:s|ed|ing)?|restor(?:e|es|ed|ing)|overwrit(?:e|es|ing|ten)|open(?:ing)? (?:a |the )?ports?|port ?forward(?:ing)?|firewall|expos(?:e|es|ed|ing)|make (?:it )?public|change (?:the |my )?password|permissions?|updat(?:e|ing) (?:the )?agent|deploy(?:s|ed|ing)?)\b/)) {
    return { intent: "sensitive", stateChanging: true };
  }

  if (has(text, /\b(set ?up|make|create|configure|build|host|new)\b.*\bserver\b|\bserver for\b/)) {
    return {
      intent: "setup",
      stateChanging: false,
      game: detectGame(text) || "minecraft",
      players: detectPlayers(text) || 10,
      wantsPlugins: /\bplugins?\b/.test(text),
      wantsMods: /\bmods?\b|\bmodpack\b|\bforge\b|\bfabric\b/.test(text),
    };
  }

  if (has(text, /\b(can|could|would|enough|room|capacity|handle|fit)\b/) && has(text, /\b(run|host|another|storage|space|backups?|capacity|handle|fit)\b/)) {
    return { intent: "capacity", stateChanging: false, game: detectGame(text) || "other", storageOnly: /\b(storage|space|backups?)\b/.test(text) && !/\brun\b/.test(text) };
  }

  if (has(text, /\bping\b|\blatency\b|\blag(?:gy|ging)?\b/)) return { intent: "players_ping", stateChanging: false };

  if (has(text, /\b(friends?|players?|people)\b.*\b(can't|cannot|can not|unable|won't|don't|not able)\b.*\b(join|connect)|\b(can't|cannot|can not|unable|won't|don't)\b.*\b(friends?|players?|people|anyone|nobody)\b.*\b(join|connect)|\b(can't|cannot)\s+(join|connect)\b/)) {
    return { intent: "join_problem", stateChanging: false };
  }

  if (has(text, /\bdocker\b|\bcontainers?\b/)) return { intent: "docker_health", stateChanging: false };

  if (has(text, /\banxnet\b|\bnetwork(?:ing)?\b|\btunnel\b|\bdns\b|\bconnected\b|\bdisconnected\b|\boffline\b/)) return { intent: "network", stateChanging: false };

  if (has(text, /\bupdates?\b|\bout ?of ?date\b|\bversions?\b/)) return { intent: "updates", stateChanging: false };

  if (has(text, /\b(crash(?:ing|ed|es)?|startup error|start-?up error|error|broken|not working|keeps (?:stopping|restarting)|why)\b/)
    || has(text, /\b(won't|wont|will not|doesn't|does not|can't|cannot|fail(?:s|ed|ing)?(?: to)?)\b.*\b(start|boot|launch|run)/)) {
    return { intent: "server_diagnose", stateChanging: false };
  }

  const metric = /\b(ram|memory)\b/.test(text) ? "memory" : /\b(cpu|processor)\b/.test(text) ? "cpu" : /\b(disk|storage|drive)\b/.test(text) ? "disk" : null;
  if (metric && has(text, /\b(most|highest|which|top|using|use|usage)\b/)) return { intent: "resource_top", stateChanging: false, metric };

  if (has(text, /\b(check|status|how is|how's|health|look at|inspect)\b/)) return { intent: "check", stateChanging: false };
  if (has(text, /\b(running|online|up)\b/)) return { intent: "check", stateChanging: false };

  return { intent: "unknown", stateChanging: false };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentions(text, name) {
  const clean = lower(name).trim();
  if (clean.length < 2) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(clean)}($|[^a-z0-9])`).test(text);
}

// Computers named by the question: the full name or id first; failing that, a
// distinctive part of a compound name ("VPS" for "vps-7360e3ad"), but only
// when exactly one computer has that part, so a part never picks between two.
function findNamedComputers(question, computers = []) {
  const text = lower(question);
  const full = computers.filter((computer) => mentions(text, computer.name) || mentions(text, computer.id));
  if (full.length) return full;
  const words = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  const scored = computers.map((computer) => ({
    computer,
    score: lower(computer.name || computer.id)
      .split(/[^a-z0-9]+/)
      .filter((part) => part.length >= 3 && /[a-z]/.test(part) && !["the", "server", "computer", "node", "desktop", "windows", "linux", "agent"].includes(part) && words.has(part))
      .length,
  }));
  const best = Math.max(0, ...scored.map((entry) => entry.score));
  const top = scored.filter((entry) => entry.score === best && best > 0);
  return top.length === 1 ? [top[0].computer] : [];
}

function computerLabel(computer) {
  return computer?.name || computer?.id || "this computer";
}

function serverLabel(server, computers = []) {
  const computer = computers.find((entry) => entry.id === server.nodeId);
  return `${server.name || server.id} on ${computerLabel(computer) || server.nodeId}`;
}

// What the question points at.
//   kind: "node" | "instance" | "container"
//   context: { selectedNodeId, selectedInstanceId } from the page the user is
//            on (stable ids chosen by the user in the app, never by the model).
// Returns { status: "resolved", target, label } | { status: "clarify", question, options }
//       | { status: "offline", target, label } | { status: "none", message }.
function resolveTarget(question, kind, inventory = {}, context = {}) {
  const text = lower(question);
  const computers = Array.isArray(inventory.computers) ? inventory.computers : [];
  const servers = Array.isArray(inventory.servers) ? inventory.servers : [];
  const containers = Array.isArray(inventory.containers) ? inventory.containers : [];
  const pointsAtSelection = /\b(this|it|current|selected)\b/.test(text);

  const namedComputers = findNamedComputers(text, computers);

  function computerResult(computer) {
    const target = { nodeId: computer.id };
    if (computer.online === false) return { status: "offline", target, label: computerLabel(computer) };
    return { status: "resolved", target, label: computerLabel(computer) };
  }

  if (kind === "node") {
    if (namedComputers.length === 1) return computerResult(namedComputers[0]);
    if (namedComputers.length > 1) return clarify("Which computer do you mean?", namedComputers.map((computer) => ({ label: computerLabel(computer), target: { nodeId: computer.id } })));
    const selected = computers.find((computer) => computer.id === context.selectedNodeId);
    if (selected && (pointsAtSelection || computers.length === 1 || !context.requireExplicit)) return computerResult(selected);
    if (computers.length === 1) return computerResult(computers[0]);
    if (!computers.length) return { status: "none", message: "No computers are set up yet." };
    return clarify("Which computer do you mean?", computers.map((computer) => ({ label: computerLabel(computer), target: { nodeId: computer.id } })));
  }

  if (kind === "instance") {
    const game = GAMES.find((entry) => new RegExp(`\\b${entry}\\b`).test(text));
    const matchesName = (server) => mentions(text, server.name) || mentions(text, server.id);
    const matchesGame = (server) => lower(server.game).includes(game) || lower(server.name).includes(game);
    let candidates = servers.filter(matchesName);
    if (namedComputers.length === 1) {
      // A named computer bounds every step to its own servers. An offline one
      // has no servers in the inventory, so it is reported, never swapped for
      // a server on another computer.
      const named = namedComputers[0];
      if (named.online === false) return computerResult(named);
      const scoped = servers.filter((server) => server.nodeId === named.id);
      const namesAServer = candidates.length > 0;
      candidates = scoped.filter(matchesName);
      if (!candidates.length && game) candidates = scoped.filter(matchesGame);
      // Its only server is taken only when the question names no game or
      // server that rules it out.
      if (!candidates.length && !game && !namesAServer) {
        if (scoped.length === 1) candidates = scoped;
        else if (scoped.length > 1) {
          return clarify(`Which server on ${computerLabel(named)}?`, scoped.map((server) => ({ label: serverLabel(server, computers), target: { nodeId: server.nodeId, instanceId: server.id } })));
        }
      }
      if (!candidates.length) {
        const label = computerLabel(named);
        if (!scoped.length) return { status: "none", message: `There are no game servers on ${label}.` };
        if (game && !namesAServer) return { status: "none", message: `${label} has no ${game.charAt(0).toUpperCase()}${game.slice(1)} server.` };
        return { status: "none", message: `No server by that name is on ${label}.` };
      }
    }
    if (!candidates.length && game) candidates = servers.filter(matchesGame);
    if (candidates.length > 1) {
      const selected = candidates.find((server) => server.id === context.selectedInstanceId && server.nodeId === context.selectedNodeId);
      if (selected && pointsAtSelection) candidates = [selected];
    }
    if (!candidates.length) {
      const selected = servers.find((server) => server.id === context.selectedInstanceId && server.nodeId === context.selectedNodeId);
      if (selected && (pointsAtSelection || !context.requireExplicit)) candidates = [selected];
      else if (servers.length === 1) candidates = servers;
    }
    if (candidates.length === 1) {
      const server = candidates[0];
      const computer = computers.find((entry) => entry.id === server.nodeId);
      const target = { nodeId: server.nodeId, instanceId: server.id };
      const label = serverLabel(server, computers);
      if (computer && computer.online === false) return { status: "offline", target, label };
      return { status: "resolved", target, label };
    }
    if (!servers.length) return { status: "none", message: "There are no game servers on the reachable computers." };
    const options = (candidates.length ? candidates : servers).map((server) => ({ label: serverLabel(server, computers), target: { nodeId: server.nodeId, instanceId: server.id } }));
    return clarify("Which server do you mean?", options);
  }

  if (kind === "container") {
    const candidates = containers.filter((container) => mentions(text, container.name) || mentions(text, container.id));
    if (candidates.length === 1) return { status: "resolved", target: { nodeId: candidates[0].nodeId, container: candidates[0].id }, label: `${candidates[0].name} on ${computerLabel(computers.find((entry) => entry.id === candidates[0].nodeId))}` };
    if (!containers.length) return { status: "none", message: "No containers were found on the reachable computers." };
    return clarify("Which container do you mean?", (candidates.length ? candidates : containers).slice(0, 12).map((container) => ({ label: `${container.name} on ${computerLabel(computers.find((entry) => entry.id === container.nodeId))}`, target: { nodeId: container.nodeId, container: container.id } })));
  }

  return { status: "resolved", target: {}, label: "" };
}

function clarify(question, options) {
  return { status: "clarify", question, options: options.slice(0, 12) };
}

module.exports = {
  GAMES,
  findNamedComputers,
  parseIntent,
  resolveTarget,
  serverLabel,
};
