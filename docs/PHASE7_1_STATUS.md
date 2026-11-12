# Phase 7.1 status: AnxNet real-world validation and phone integration

Last update: 2026-11-12. Continues from `32881de4` (Phase 7). Combines the
remaining Phase 6.2 AnxNet work with Phase 7 phone verification.

**In one line:** everything that could be built and verified on this one PC
is done and tested; every real-hardware, real-internet and system-change
check is still open and listed under "Needs your approval".

## 7.1A Audit and gap matrix

Local commits `9c91ec7a` … `32881de4` (Phases 6, 6.1, 7) are intact; nothing
was pushed.

| Area | State at the start of 7.1 | Gap | What 7.1 can do without approval |
| --- | --- | --- | --- |
| AnxNet between two computers | Windows ↔ WSL (separate network stacks, one PC): 7/7 | Two physical computers | Prepare; the run on Anxlab (192.168.1.134) needs approval (it hosts live servers) |
| Servers on other computers | Shared from the desktop's AnxNet node by LAN address; stops when the desktop is off | Agent-side AnxNet | Build and test the Agent integration in isolation; installing it on a real Agent needs approval |
| Management-port protection | Advertised port checked; edge checks both ports | **Forwarded (target) port not checked on the private network; Agent default port 47131 and the phone gateway port not listed** | Fix (security) |
| Private DNS | Resolver verified with Windows' DNS client on port 53; NRPT plan built | OS-wide rule never applied | Non-privileged checks; applying the NRPT rule needs approval and a UAC click |
| Internet P2P / relay | Emulated NAT, hole punching and relay on one host | Real internet, CGNAT | Local CGNAT/NAT classification and honest reporting; a VPS edge needs approval |
| Public gateway | Two servers, 20 players, route cleanup (locally) | Real public hosting | Readiness and protection checks; a public endpoint needs approval |
| Phone app | Edge phone emulation: 17/17; gateway smoke: 20/20 | Real iPhone / Android | Fix known mobile-browser issues; add an on-device check the owner can run and send back |
| Phone + AnxNet | LAN only; 100.64/10 sources accepted | Remote phone access | Choose and document the smallest secure path |
| Desktop Home status | Uses the renderer's last node list | Showed a reachable computer as offline until a refresh (seen in Phase 7 tests) | Fix |

## What changed

### Security fixes (7.1H)

- **Forwarded ports are checked too.** AnxNet refused a management port only
  when it was the *advertised* port. "Share 25565, forward to 22" passed. Now
  `roster.addService` checks the target port, the hosting node refuses a
  blocked target on every TCP stream, UDP flow and gateway connection (so an
  older roster can't open one either), and `shareService` checks before
  asking the owner.
- **More management ports.** 47131 (the Agent's default port) and 47800
  (Phone Access) joined SSH, Docker, RDP, VNC, WinRM and 6566, in AnxNet and
  in the Share dialog's warning. Each computer also blocks its own extra
  ports: the desktop passes every registered Agent's port and the phone
  gateway's port to its AnxNet node; an Agent passes its configured port.
- **Desktop Home showed reachable computers as offline.** The fleet check
  re-checked computers in the main process, but the window kept its old node
  list. It now reloads the list when the fleet check disagrees (2–3 s in the
  test, without any manual refresh).

### 7.1B AnxNet inside the Agent

The Agent runs the same AnxNet node as the desktop (`src/anxnet/node.js`); no
second networking agent and no second backend.

- `agent/src/services/anxnetAgentService.js`, `agent/src/routes/anxnet.js`:
  `GET /api/v1/anxnet/status` (public-access:read) and `POST
  /api/v1/anxnet/{join,leave,share,unshare}` (public-access:write), the same
  tiers as Playit and Public Access.
- Joins only with an invite from the network's owner, sent over the Agent's
  authenticated API. Never creates networks or invites.
- Shares only ports its own server declares, always on 127.0.0.1. Its own
  Agent port, SSH and the other management ports are refused.
- No name resolver or local forwards on the Agent: a server shares, it
  doesn't consume other members' services.
- Key and state in `<Agent data>/anxnet` (0600 key file), resumed at Agent
  start only if it was in a network, stopped on Agent shutdown.
- Listens on `AGENT_ANXNET_PORT` (default 47711) once it joins a network.
- Packaging: `src/anxnet` is now part of the Agent runtime (runtime manifest,
  extraResources, `.deb` build, payload fallback, closure smoke).
- Desktop: Computers > AnxNet lists computers with the AnxOS Agent, with
  **Add to AnxNet** (a single-use, pre-approved invite, withdrawn if unused)
  and **Remove** (revoke + leave). The Share dialog shares a server *from its
  own computer* when that computer is in the network, so it stays reachable
  with this PC off. Anyone can join for servers on other computers isn't
  available yet (the dialog says so and points to Playit).
- New IPC: `anxnet:agentStatus` (public-access:read), `anxnet:addComputer`,
  `anxnet:removeComputer`, `anxnet:agentShare`, `anxnet:agentUnshare`
  (instance:write, audited).

### 7.1C Private DNS

No code change was needed. The audit found: the resolver answers only
loopback clients and its own domain, never recurses; service names have the
form `minecraft.mini-pc.anx-juniper41.internal`; device and service labels are
made unique (`desktop`, `desktop-2`, …); one AnxNet network per computer, so
two networks can't collide on one machine; the NRPT rule is tagged per
network and refuses namespaces another program (Tailscale) handles. Applying
the OS rule is still waiting for your approval.

### 7.1D Internet readiness

- `src/anxnet/reachability.js`: a local reading of this computer's addresses.
  It tells carrier-grade NAT (100.64/10 from the provider) apart from VPNs
  in the same range (Tailscale), skips virtual adapters (WSL, Hyper-V,
  VirtualBox by name or MAC), and says what that means for outside devices.
  It never claims a test from outside (`testedFromOutside: false`).
- Shown on Computers > AnxNet and on the phone's Sharing tab. On this PC it
  reads "home network behind a router" (192.168.1.20; Tailscale seen as a
  VPN).

### 7.1F Phone fixes

- Text fields at 16px (iPhone Safari zooms in under 16px).
- Rotation allowed (`orientation: any`), a compact landscape layout, side
  safe-area insets for notched phones in landscape.
- `interactive-widget=resizes-content`, so Android Chrome resizes the page
  for the keyboard instead of covering the console box.
- No grey tap flash; `touch-action: manipulation`.
- Service worker cache bumped to `anxos-shell-v2` so installed copies update.
- **Check this phone** (More): runs on the real device and records whether
  the page is a secure context, whether the service worker is active (browsers
  refuse it on an untrusted certificate, so this shows real certificate
  trust), whether it runs as an installed app, the median latency to the
  computer, screen size, safe-area insets, orientation, sideways scrolling
  and text-field size. The result is sent to Phone Access on the computer,
  which lists the last results ("Phone checks"). Any paired role may send one;
  only fixed fields are kept (markup and extra keys dropped); rate limited.
  It contains browser facts only, no server data.
- More shows how the phone is connected: "your home network", "a VPN
  (100.64.0.0/10, for example Tailscale)" or "this computer".

### 7.1G Phone + AnxNet: the chosen path

A browser app can't join AnxNet, and a public phone gateway is ruled out. The
smallest secure path, which needs no new code (it has not been tried with a
phone over Tailscale yet):

- **At home:** the LAN gateway (Phase 7).
- **Away from home:** an existing VPN on the phone and the computer, for
  example Tailscale. The gateway already accepts 100.64/10 sources and its
  certificate already covers this computer's Tailscale address
  (its 100.x tailnet address), so nothing new is exposed. The phone shows that it
  is connected through a VPN.
- **A native AnxNet phone client** is the long-term option. It needs a
  store app (approval) and is not started.

The Sharing tab shows the AnxNet status the computer's node reports, plus the
reachability reading.

### 7.1H Recovery checks

Verified (gateway smoke): phones stay paired across an AnxOS restart (same
cookie and CSRF, certificates reused); an upload cut off half-way writes
nothing; a second gateway on a port in use fails with a message instead of a
crash; Check this phone is accepted from any paired role, cleaned and rate
limited. Already verified in Phase 7 and re-run: revocation, idle expiry,
desktop lock and unlock, network loss and recovery, closing the phone.

Certificate rotation: the gateway certificate is reissued from the same local
CA when addresses change or within 30 days of expiry, and phones keep
trusting it. If the CA itself is deleted, phones must install the new one;
the fingerprint on Phone Access shows which is current.

## Verification

All on this Windows 11 PC.

| Command | Kind | Result |
| --- | --- | --- |
| `node scripts/anxnet-smoke.js` | Real sockets, one host, NAT emulated | 13/13 (new: X13 management ports; X1 now includes the reachability reading) |
| `node scripts/anxnet-agent-smoke.js` | Real Agent process + owner node, one host | 8/8 (new): join by invite, share and reach the game, management ports refused, unshare, stop and resume, revocation, restricted principal refused, no secrets in status |
| `node scripts/anxnet-ui-qa.js` | Real Electron app, real Agent | 8/8 (new: U8 add the Agent's computer from the UI, share from it, reach it, stop sharing, remove) |
| `node scripts/mobile-gateway-smoke.js` | Plain Node, fake services | 25/25 (new: G21–G25) |
| `node scripts/mobile-ui-qa.js` | Real Electron app + Agent, Edge phone emulation | 19/19 (new: M18 landscape and 16px fields, M19 Check this phone; M2 now requires desktop Home to agree by itself) |
| `node scripts/permission-matrix-smoke.js` | Real permission core | 78 desktop families (404 channels), 44 Agent REST families |
| `node scripts/preload-exposure-contract-smoke.js` | Unit | 8/8 |
| `npm run qa:feature` | Feature tier | 109 checks, including `git diff --check` |

`node scripts/agent-package-closure-smoke.js` fails in this worktree before
reaching the new path: the worktree has no `node_modules` of its own, so
`js-yaml` resolves from the parent checkout. That is the environment, not this
change; it needs a checkout with its own `npm ci`.

Test fix along the way: when an AnxNet UI step failed before U7, the test's
cleanup waited forever on the background AnxNet host (it holds Playwright's
pipe). Cleanup now stops the host first and closes the app with a time limit,
and prints the failure immediately.

## Simulated vs real

- **Real:** sockets, TLS, the Agent process, the Electron app, Microsoft
  Edge's engine.
- **Simulated:** separate computers (separate processes and identities on one
  PC), NAT, phones (Edge with phone viewport, touch and user agent).
- **Not done at all:** two physical computers, the internet, a public
  gateway, real iPhone or Android, the OS-wide DNS rule.

## Needs your approval (nothing below was done)

1. **Anxlab as the second computer** (192.168.1.134, hosts live servers): run
   `scripts/anxnet-two-machine-test.js` there with a temporary Node in /tmp,
   as was done in WSL; or update its Agent to a build with AnxNet and use Add
   to AnxNet. An Agent update stops its servers (Lessons Learned, 2026-10-30).
2. **Windows DNS rule** for `.<network>.internal` (one UAC prompt), to verify
   generated names in real games.
3. **An AnxNet edge on the VPS** (relay and gateway): a process plus a firewall
   port range, for real internet P2P, relay and Anyone can join.
4. **Real phones:** you pair an iPhone (and an Android phone if available) and
   run **More > Check this phone**; the results then appear in Phone Access.
5. Pushing the commits.

## Handoff

- Start with "Needs your approval" above; each item has a ready test.
- On Anxlab, check the AnxNet port (`AGENT_ANXNET_PORT`, default 47711) is
  free and decide whether it should listen on the LAN; it opens only after the
  computer joins a network.
- Re-run `anxnet-agent-smoke`, `anxnet-ui-qa` and `mobile-ui-qa` after
  changes to AnxNet, the Agent routes or the phone app.
