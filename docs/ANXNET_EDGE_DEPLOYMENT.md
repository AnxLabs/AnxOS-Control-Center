# Running an AnxNet edge on your own server

An AnxNet edge is a small program you run on a server that the internet can
reach, for example a VPS. It does two jobs, each one optional:

- **Relay.** Two of your devices that can't reach each other directly (both
  behind home routers or CGNAT) connect through it. Their traffic stays
  end-to-end encrypted; the relay only passes on bytes it can't read.
- **Public gateway ("Anyone can join").** A game server you share gets a
  public `address:port` on the edge, so friends can join with a normal game
  client and no AnxNet.

AnxOS never sets this up by itself. Every step below is something you choose
to do on your own server.

## Status (Build 213)

| What | Tested how | Result |
| --- | --- | --- |
| Config check (`--check`, refused bad configs) | `scripts/anxnet-edge-deploy-smoke.js` E1, E2 | Passed |
| The edge as its own process, from the panel's config | Same smoke, E3–E5, loopback on one Windows PC | TCP and UDP through the gateway, relay between two members, ports closed on stop |
| "Copy edge config" in the real app | `scripts/anxnet-ui-qa.js` U4 | Passed |
| systemd unit | `systemd-analyze verify` in WSL Ubuntu 24.04 | No problems reported |
| A real server on the internet | Not done | Needs your approval (it opens public ports) |

So nothing has been tested over the internet yet. The first real test is the
deployment below.

## What it costs and exposes

- **Cost:** nothing extra on a server you already pay for. Bandwidth through
  the relay and gateway counts against that server's traffic allowance.
- **Open ports:** the edge port (default `47700/tcp`) and, only if you turn on
  the gateway, its port range (default `30000-30099`, TCP and UDP). `--check`
  prints the exact list for your config.
- **Never opened:** the edge refuses any gateway range that includes SSH (22),
  the AnxOS Agent (47131, 6566), Docker, Remote Desktop, VNC, WinRM or Phone
  Access (47800), and gateway ports below 1024.
- **Who can use it:** only devices in the networks listed in `edge.json`,
  checked against the owner's signed member list on every connection.
  Removing a device in AnxOS cuts it off the relay and gateway.
- **Public routes:** each one needs a grant signed by your AnxOS for this
  edge's fingerprint, and ends when sharing stops, when the grant expires
  (7 days, renewed automatically) or when the edge stops.

## Steps

You need a Linux server with the AnxOS Agent package, Build 213 or later
(it installs the edge program and its Node runtime under `/usr/lib/anxos-agent`).

1. **Get the config.** In AnxOS, on the network owner's computer, open
   Computers > AnxNet > Advanced and choose **Copy edge config**. It copies
   an `edge.json` with your network's id and the owner's public key (both
   public; no secret is in it). The relay is on and the gateway is off.

2. **Optional: turn on the gateway.** In `edge.json`, set
   `"gateway": { "enabled": true, "publicHost": "<the server's public IP>", "portRange": [30000, 30099] }`.

3. **Put it on the server and check it:**

   ```bash
   sudo install -d -m 0755 /etc/anxnet-edge
   sudo install -m 0644 edge.json /etc/anxnet-edge/edge.json
   /usr/lib/anxos-agent/node/bin/node /usr/lib/anxos-agent/src/anxnet/bin/anxnet-edge.js --config /etc/anxnet-edge/edge.json --check
   ```

   `--check` starts nothing. Fix anything it lists as a problem.

4. **Open only the ports `--check` printed** in the server's firewall and in
   your hosting provider's firewall, if it has one. For example, with ufw:

   ```bash
   sudo ufw allow 47700/tcp
   sudo ufw allow 30000:30099/tcp
   sudo ufw allow 30000:30099/udp
   ```

5. **Run it as a service** with the template in
   `packaging/anxnet-edge/anxnet-edge.service`. The service runs as its own
   throwaway user, can't write outside `/var/lib/anxnet-edge`, and checks the
   config before every start.

   ```bash
   sudo install -m 0644 anxnet-edge.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now anxnet-edge
   journalctl -u anxnet-edge -n 20
   ```

   The log shows `Fingerprint (add this in AnxOS): SHA256:…`.

6. **Add it in AnxOS.** In Computers > AnxNet > Advanced, enter the server's
   address, port `47700` and that fingerprint. Tick **Use as relay**, and
   **Use as public gateway** if you turned it on. Save. Your devices pick it
   up by themselves.

7. **Test it.** Share a server with **Anyone can join**. AnxOS says "Friends
   can join at …" only after its own test connection through the gateway
   reached the game.

## Turning it off

- Untick the edge in AnxOS and save; devices stop using it.
- On the server: `sudo systemctl disable --now anxnet-edge`, then close the
  firewall ports you opened.
- `/var/lib/anxnet-edge` holds the edge's key. Delete it only if you won't
  use this edge again: a new key means a new fingerprint to enter in AnxOS.
