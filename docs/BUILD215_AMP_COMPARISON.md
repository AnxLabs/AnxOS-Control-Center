# Build 215: AnxOS and AMP — comparison plan and AnxOS measurements

**Status: no AMP test was run.** No AMP licence or AMP test machine was
available in this build, so every AMP column below is the AMP *baseline,
unverified*. Nothing here claims AnxOS is better than AMP. The AnxOS figures
are measurements taken in Build 215 (dates and environments stated), or are
marked as not yet measured.

## What AMP documents (unverified)

Taken from third-party guides found on 2026-11-19, not from CubeCoders'
own documentation and not tested:

- A self-hosted web panel for game server instances, on Windows and Linux,
  each instance with its own console, file manager, scheduler and player
  management (space-node.net, 2026 guide).
- Updates through an "Updates" tab with "Check for Updates"
  (Linode/Akamai and VPSie installation guides).
- Docker isolation listed as a feature row by a competitor's comparison
  page (gamecp.com/compare/amp); how it works is not described there.
- Licensing tied to the number of instances; the sources disagree on
  prices and the free tier.

Before any comparison is published, these must be checked against
CubeCoders' own documentation and a real AMP install.

## The five workflows

Each workflow is run on equivalent hardware for both products, by someone
who has not used either before, timing from the first click.

| # | Workflow | What is measured |
| --- | --- | --- |
| 1 | Install and start a Minecraft Java server, join it from the same LAN | actions, minutes to a joinable server, errors seen |
| 2 | Deploy a Docker application (Uptime Kuma) and sign in | actions, minutes, whether the admin password had to be found by hand |
| 3 | Manage workloads on two computers (see both lists, stop one on each) | actions, whether a computer had to be switched |
| 4 | Back up and restore a server | actions, minutes, restore verified by joining |
| 5 | Diagnose and recover a failed workload (port already in use) | time to a correct explanation, actions to recover |

Also recorded: install completion rate (out of 5 attempts), idle memory of the
panel and agent, and whether any step needed a terminal.

## AnxOS: what is measured so far

| Workflow | AnxOS (Build 215) | AMP |
| --- | --- | --- |
| 1 Minecraft install | Add Server → Minecraft → Create server: 3 actions in the UI path (name, port and memory are prefilled; the fit check needs no action). Time not measured in Build 215. | unverified |
| 2 Docker application | Build 214 real installs: each of the nine services installed and signed in with the generated password shown once (no terminal). Build 215: Update keeps data, 28 s on Docker Desktop (nginx). | unverified |
| 3 Two computers | My Servers › All computers lists servers and Docker services on every computer; Stop on two computers is one selection and one confirmation, no switching. List refresh with Docker: 0.21 s median per computer (Docker Desktop, 8 containers). | unverified |
| 4 Backup and restore | Not re-measured in Build 215. | unverified |
| 5 Failed workload | A busy port is refused before anything is created, with the program holding it named (Build 214); a crashed container shows as Crashed with its exit code. Time not measured. | unverified |

Agent maintenance (no AMP equivalent run): a real package update of the
Agent from Build 213 to 214 took 13 s through the update helper and 18 s on
the VPS through passwordless sudo (Build 214); Update all over two computers
took 17 s; key sign-in setup took about 0.5 s.

## Where AnxOS can honestly aim to be simpler

These are design goals backed by what Build 215 implemented, not results:

- One list of game servers *and* Docker services across computers.
- No terminal for Agent updates once the node's owner has opted in to the
  update helper, with verified packages and automatic rollback.
- Plain-language "will it run here" and error explanations before anything
  is created.
- Docker updates that say what is and is not rolled back.

## To run the comparison

1. Get an AMP licence that allows two instances, and a second disposable PC.
2. Run each workflow five times per product with a stopwatch and a screen
   recording; count clicks and typed fields from the recording.
3. Fill both columns; mark anything not run as not run.
