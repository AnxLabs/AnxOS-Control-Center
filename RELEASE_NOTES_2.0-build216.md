# AnxHost Control Center v2.0 — Build 216

AnxOS Control Center is now **AnxHost Control Center**. Build 216 is a new look and a new layout for everything you already use, with the same features, the same data and the same Agents. Your servers, computers, settings, backups, SSH profiles and paired phones carry over when you update.

## Added

### New look

- **A new design throughout.** Every page uses one set of colours, type, spacing and status shapes. The title bar shows the current page, a search box, the command palette, the Assistant, a "running" pill for work in progress, and the selected computer's status.
- **A simpler sidebar.** Run (Home, My Servers, Add Server), Infrastructure (Computers, Docker, Network) and Tools (Files, Terminal, Backups), with Activity, Security and Settings at the bottom. Related pages are now tabs: Terminal has SSH and Server consoles; Activity has Notifications, Task details and Maintenance; Computers has Agent Control; Network has Sharing and Addresses. Narrow windows get an icon rail (Ctrl+B opens the full sidebar).
- **Light theme.** Settings › Appearance › Theme offers Dark (default), Light and System. Terminals, consoles and the code editor stay dark.
- **Add Server in the main window.** Marketplace and Create Server no longer open separate windows. All 50 templates have new original artwork.
- **Add Storage in the main window**, as a dialog.
- **Phone Access** uses the same design, follows your phone's light or dark setting, and has the new AnxHost icon. Phones paired with Build 215 stay paired.
- **A new installer, AnxHost Setup.** Its own window shows what it will do (new install, upgrade from AnxOS Control Center, update or repair), what is kept on this PC, and real progress, with no standard installer pages. It checks the install engine it carries (checksum and AnxLabs signature) before running it, and keeps the normal Windows permission prompts. Uninstall has its own window too. Silent installs (`/S`) and in-app updates work as before. On a PC without Microsoft Edge WebView2, Setup says so and continues with the standard installer.
- **New names.** The shortcut and uninstall entry say AnxHost Control Center; the background service is shown as "AnxHost Helper". The install folder, data folder and background task keep their names, so updates are in place.

### Sign-in

- **Stay signed in on a trusted device.** "Trust this device (stay signed in for 30 days)" on the lock screen keeps the Local Owner signed in across restarts, stored only in Windows secure storage and renewed on every start. Removing the device in Security signs it out.
- **Automatic lock when you are away.** The app locks after 15 minutes without use by default (5, 15, 30, 60 minutes or Never in Security), and when Windows locks or sleeps. **Lock Owner Workspace** now really signs you out until you sign in again.

## Fixed

- **Phone: installed add-ons were never listed** on the Add-ons tab (since Build 211). They are now.
- **Phone: Check this backup** always said "done"; it now shows the real result (verified or failed, with the reason).
- **Set up key sign-in failed about once in 200 tries.** The SSH library sometimes made a key that nothing could read; such a key is now replaced before it is used.
- **A crash-looping server could lose its "crash loop" status.** A status refresh at the wrong moment could put an older state back (for every server, and again for NeoForge servers); it now updates only the details it owns.
- **A server could show the wrong state, or lose a settings change, when two things happened at once.** A status refresh could put "Stopped" or "Failed" back over a Start you had just made, and a Start or a settings save could undo the other's change. Each now updates only what it changed, and a status refresh no longer recreates a server you had just deleted.
- **On a busy Windows computer, Stop or Force Kill could end an unrelated program.** If checking a remembered process ID took too long, the server's old process ID was trusted, even though another program might be using it by then. Stop and Force Kill now refuse and say to try again, and the check is repeated on the next refresh.
- **AnxNet: a shared server you couldn't reach looked reachable.** When this computer couldn't open the local port for a friend's server (another program had it, or Windows reserved it), nothing said so and it was never retried. The server now shows why, and AnxNet keeps trying until the port is free.
- **Reverse proxy routes show the real reason they were refused** (for example, an invalid hostname) instead of a generic message.
- **On a busy Windows computer, saving a server's state could fail**, including recording a crash or starting the server, when another program had the file open for more than a moment. Saves now keep retrying for up to 3 seconds.
- **Add Storage did nothing.** Save, Test Connection and Cancel in Build 215's Add Storage window had no effect; the new dialog works.
- **Files could not open folders on a Windows Agent computer.** Opening a subfolder on a Windows computer's Agent was refused; it works now.
- **The accent colour** (Settings › Appearance) had stopped changing most of the app; it applies everywhere again.
- **Placeholder text** in Settings, dialogs and the command palette was too faint to read comfortably; it now meets contrast guidelines.
- **SSH and Console toolbars** cut off Copy, Clear, Fullscreen and the command box in smaller windows; they wrap now.
- **The Files path hint** read "C:SERSYOU"; it reads "C:\Users\you".
- **Keyboard focus** in Customize Home and the first-server guide no longer falls behind the dialog.
- **Revoking your own session** no longer shows "Sign in to continue." after it succeeded.

## Removed

- The hidden AMP and Coolpals pages, the old inline Create Instance form, the separate Marketplace, Create Server and Add Storage windows, the Expo "Pair Mobile Device" buttons in Agent Control (Phone Access replaces them), and a disabled backup search box. Nothing they did is lost: each has a working replacement.

## Known limitations

- Package, file and folder names keep "AnxOS" (`AnxOS-Agent-*.deb`, the `AnxHub` data folder, the `AnxOSAgent` task) so updates stay in place. The website domain is unchanged.
- AnxHost Setup was built and tested on the development PC unsigned; installing, upgrading and uninstalling with it are first tested from this build's signed release candidate.
- See `docs/KNOWN_LIMITATIONS.md` for the full list.

## QA

- A real Build 215 app wrote an owner, a setting, a computer and its token, an SSH profile, a backup, a favorite and a paired phone; Build 216 opened the same profile and kept all of them (8/8).
- A Build 216 desktop ran a server on the Build 215 Agent: start, console, stop, files and backups (5/5).
- Every one of the 1,573 mapped features has a test that uses it in the real app, including every phone screen and action.
- Light and dark themes were checked over 69 views with no text below WCAG AA contrast, and every toolbar control was checked to be reachable at three window sizes.
- Startup and page switching of the redesigned desktop were measured within the approved budget (Build 215 plus 10%).
