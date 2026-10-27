# devices: Safari automation on iPhone, iPad and the iOS Simulator

Scripts that open the player or the device probe in Safari on a real iPhone or iPad (over USB) or on an iOS Simulator, wait for a condition, read telemetry, tap, take screenshots and collect console logs. Spec: `docs/superpowers/specs/2026-10-17-m5d-bdj-menus-design.md` §4.5.

They speak W3C WebDriver to [Appium](https://appium.io) with the XCUITest driver. Appium uses Safari's remote inspector for the page (scripts, console) and WebDriverAgent, a helper app it builds with Xcode, for touches and screenshots. Taps are real touches, so they count as the user gesture the player needs to start audio.

The Simulator needs no setup beyond Xcode. A real device needs the one-time setup below.

## Install Appium (once)

Appium and its driver live in `.cache/appium` (gitignored), not in `package.json` and not globally. They need Node 20.19+, 22.12+ or 24+ and npm 10 or later (this repository's CI uses Node 24 and npm 11.19+, which work); check with `node -v` and `npm -v`. In a worktree, `.cache` may be a link to the main checkout's `.cache`, in which case every worktree shares one install.

```sh
npm install --prefix .cache/appium appium@3.8.0
APPIUM_HOME="$PWD/.cache/appium" .cache/appium/node_modules/.bin/appium driver install xcuitest@12.18.1
```

npm skips Appium's `postinstall`. That is fine: the script only auto-installs extensions named in an environment variable. The scripts start this Appium themselves when nothing answers at `$APPIUM_URL` (default `http://127.0.0.1:4723`), and stop it afterwards. The first session on a device builds WebDriverAgent, which takes a few minutes; later sessions start in about 15–30 s.

## Run

```sh
npm run build
npm run disc-server -- --root fixtures/synthetic                      # Simulator: plain HTTP on 127.0.0.1 is enough
npx tsx tools/devices/probe.ts --device "sim:iPhone 17" --server http://127.0.0.1:8080 \
  --token <token the server printed> --disc disc1 --out probe.json --screenshot probe.png
npx tsx tools/devices/run.ts --device "sim:iPhone 17" \
  --url "http://127.0.0.1:8080/?telemetry=1&disc=<disc URL>&token=<token>" \
  --until "document.querySelector('[data-testid=server-discs] button')" \
  --tap-on "[data-testid=server-discs] button" \
  --until "document.querySelector('[data-testid=playlist-00000]')" --tap-on "[data-testid=playlist-00000]" \
  --until "window.__blurayTelemetry?.framesPresented > 30" \
  --telemetry telemetry.json --screenshot playing.png --console console.txt
```

`--device` takes one of two forms:

- `sim:<name>`, the name `xcrun simctl list devices available` shows. The newest runtime wins, and the Simulator is booted if needed.
- A real device's UDID, from `xcrun xctrace list devices`.

`run.ts` runs its steps in the order given:

- `--until <js>` polls until the expression is truthy. `--timeout <ms>` sets how long it waits (default 60000).
- `--tap x,y` taps at page coordinates, in the CSS pixels of `clientX`/`clientY`.
- `--tap-on <css selector>` taps the centre of the first visible match.
- `--swipe x1,y1,x2,y2` drags a finger between two page points over 300 ms. Safari scrolls the page itself, as for a person, unlike a scripted `scrollTo`.
- `--wait <ms>` sleeps.
- `--screenshot <png>` saves the device screen.
- `--telemetry <json>` saves `window.__blurayTelemetry`; the URL needs `?telemetry=1`.
- `--eval <js>` prints the value; a promise is awaited.

`--console <txt>` writes Safari's console log at the end of the run. `--call-timeout <ms>` bounds each WebDriver call.

`probe.ts` opens `probe.html?disc=<disc API base, …/api/discs/<id>/>&token=<token>`, which probes a disc on the disc server instead of a picked folder. The page only accepts a disc on its own server, so the token is never sent anywhere else; `/probe.html` itself is static and needs no token. On this route:

- The "Blob slicing over 4 GiB" row is an HTTP range read past 4 GiB; its detail starts with `server:`.
- The HEVC row decodes the disc's first HEVC GOP, read over HTTP.

For a real device, use the server's HTTPS LAN origin (`--server https://<lan-ip>:8443`) and run with `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`, so the script can read the server's disc list. The USB route (a folder picked in Files) needs a person to pick the folder: open `https://<lan-ip>:8443/probe.html` on the device and tap "Pick a disc folder".

## One-time setup for a real iPhone or iPad

Xcode must be installed with its licence accepted (`sudo xcodebuild -license accept`). The menu labels below are as of iOS 18. **On iOS 26 the exact labels still have to be confirmed on the device**; those steps are marked *to confirm*. If a label differs, use the nearest match and note the right one here. Do the steps in this order for each device:

1. **Trust this Mac.** Connect the device by USB-C, unlock it, tap Trust and enter the passcode. `xcrun xctrace list devices` then lists it with its UDID.
2. **Let Xcode prepare the device.** With the device connected and unlocked, open Xcode → Window → Devices and Simulators and select the device. Xcode copies its debugging support onto the device, which can take several minutes the first time. Wait until the device shows no progress or warning there.
3. **Developer Mode.** The switch only appears once the device has been used with Xcode (step 2). Settings → Privacy & Security → Developer Mode (*to confirm*; near the bottom) → on. The device restarts; after unlocking, confirm Turn On.
4. **Web Inspector and Remote Automation.** Settings → Apps → Safari → Advanced (*to confirm*). Turn on Web Inspector (Safari's remote inspector, used for scripts and console logs; it also lets you inspect the page from Safari on the Mac through the Develop menu) and Remote Automation.
5. **Apple ID in Xcode.** Xcode → Settings → Accounts → + → Apple ID. A free Apple ID gives a "Personal Team". Its Team ID is a 10-character code, shown in signing errors and in the provisioning profile Xcode makes in step 6.
6. **Sign WebDriverAgent with the personal team.** Open the driver's project:
   ```sh
   APPIUM_HOME="$PWD/.cache/appium" .cache/appium/node_modules/.bin/appium driver run xcuitest open-wda
   ```
   - `WebDriverAgentRunner` target → Signing & Capabilities: tick "Automatically manage signing", choose your Personal Team, and set a bundle identifier unique to you, e.g. `com.<yourname>.WebDriverAgentRunner`. A free team cannot sign the default `com.facebook.*` identifiers.
   - `WebDriverAgentLib` target: choose the same team and use the same prefix, `com.<yourname>.WebDriverAgentLib`.
   - Keep these identifiers consistent with `WDA_BUNDLE_ID` in step 8, which must be exactly the Runner's identifier. Otherwise Appium rebuilds under an identifier your profile doesn't cover, and signing fails.

   Select your device as the run destination and press ⌘U (Product → Test).

   **The first ⌘U is expected to fail** with an error saying the developer or app is not trusted ("Untrusted Developer", "invalid code signature" or "profile has not been explicitly trusted by the user"). That is normal for a free team; step 7 fixes it.
7. **Trust your developer app on the device.** Settings → General → VPN & Device Management (*to confirm*) → your Apple ID under Developer App → Trust. Press ⌘U again: WebDriverAgent starts on the device, which shows "Automation Running". Stop it in Xcode (⌘.).
8. **Tell the scripts** your team and bundle identifier through the environment, never in the repository:
   ```sh
   export DEVICE_TEAM_ID=<your team ID>
   export WDA_BUNDLE_ID=com.<yourname>.WebDriverAgentRunner      # exactly the Runner's identifier from step 6
   ```
9. **Trust the disc server's certificate authority.** Make the mkcert certificate as in `tools/disc-server/README.md`.
   - Send the device **only** `"$(mkcert -CAROOT)/rootCA.pem"`, by AirDrop or by mailing it to yourself. **Never copy `rootCA-key.pem`** from the same folder: it is the CA's private key, and whoever has it can make certificates your devices would trust for any site.
   - On the device, open the file; Settings shows "Profile Downloaded". Install it under Settings → General → VPN & Device Management (*to confirm*).
   - Turn on full trust under Settings → General → About → Certificate Trust Settings → the mkcert root.

   To check, open `https://<lan-ip>:8443/` in Safari on the device; there should be no certificate warning. The device must be on the same Wi-Fi as the Mac.

   *To remove it later:* on the device, Settings → General → VPN & Device Management → the mkcert profile → Remove Profile (this also removes the full-trust switch). On the Mac, `mkcert -uninstall` removes the CA from the Mac's trust stores, and deleting the `mkcert -CAROOT` folder deletes the CA itself.

**Every 7 days:** a free team's provisioning profile lasts 7 days. After that, WebDriverAgent stops launching: you get "profile has expired", or the app closes at once. To re-sign, connect the device, open the project as in step 6 and press ⌘U again; Xcode renews the profile. If Xcode complains, delete WebDriverAgentRunner from the device first. Apple currently limits free teams (at the time of writing, about 3 devices and 10 app IDs per 7 days). That is enough here, but the limits may change.

If Appium cannot find a connected device running iOS 17 or later, start the driver's device tunnel in another terminal (it needs root) and retry:

```sh
sudo APPIUM_HOME="$PWD/.cache/appium" .cache/appium/node_modules/.bin/appium driver run xcuitest tunnel-creation
```

## When a run fails

- `device disconnected or session lost: …`: one of these happened:
  - the device was unplugged or locked;
  - WebDriverAgent crashed, or its profile expired;
  - Appium stopped.

  Every WebDriver call has a timeout (`--call-timeout`, default 120 s, or `$DEVICE_CALL_TIMEOUT_MS`), so a hung device fails instead of hanging.
- `page reloaded (possible memory kill) during …`: the page the run opened went away under it. On iOS that usually means Safari killed the tab for memory. `run.ts` marks the page after `--url` opens it (`window.__runMarker`), and `--until` (and `probe.ts`'s wait) check the mark on every poll. A step that navigates on purpose also trips it.

## The Simulator

Nothing to set up. WebDriverAgent needs no signing there, and the Simulator shares the Mac's network, so plain HTTP on `127.0.0.1` is a secure context and the disc server needs no certificate. To test HTTPS there anyway, add the mkcert root with `xcrun simctl keychain booted add-root-cert "$(mkcert -CAROOT)/rootCA.pem"`. Simulator Safari runs on the Mac's media stack and CPU, so codec support and timings there say nothing about the real devices.

## The BD-J gate (`gate.ts`)

The 5d device gate (spec §4.5, §7) on one device or browser, for each BD-J disc under `fixtures/local` (A_NEW_ERA, RENTAL_FAMILY):

1. Opens the disc by its disc-server URL and taps or clicks its button.
2. Records `bdj.firstFrameMs` (the first frame of Java's first playlist).
3. Drives the menu to the feature with the disc's key script (`tests/bdj/scripts/<disc>.play.keys`), and checks the BD-J plane at every `wait still` against libbluray's settled hashes (`tests/bdj/golden/local/`). A computer uses the keyboard. A touch target taps the menu, which the disc ignores, so the on-screen remote opens; it then taps the remote's buttons. If that tap does not open the remote, the gate shows the controls first (a tap off the picture, or a long press where the picture fills the screen), because an idled-out control bar lets a tap on its Remote button fall through to the picture, and then taps Remote and checks that the remote opened. The result's `firstTap` records whether the engine counted the first tap as ignored (`ignored`, `tapsIgnoredBefore`/`After`), what lay under the tap point (`tapTarget`: `video-canvas`, or whatever took the tap) and how the remote was opened (`how`).
4. Records `bdj.inputLatencyMs` for every input.
5. Before the key that starts the feature, it stays in the menu for `--stay-ms` (default 10 minutes). It moves the focus every `--cycle-ms`, samples `bdjMemory` every `--sample-ms`, and then checks that the menu settled back on its golden plane.
6. Fails at once on a page reload. On iOS a reload means a memory kill.

```sh
npm run build
npx tsx tools/devices/gate.ts --target "sim:iPhone 17" --stay-ms 600000     # Simulator (Appium)
npx tsx tools/devices/gate.ts --target chrome --startup-runs 5              # installed Chrome (Playwright); --touch: Pixel 7 emulation
npx tsx tools/devices/gate.ts --target firefox --disc RENTAL_FAMILY         # installed Firefox (Playwright over WebDriver BiDi)
npx tsx tools/devices/gate.ts --target safari                               # Safari on this Mac (safaridriver)
npx tsx tools/devices/gate.ts --target ios:<udid> --server https://<lan-ip>:8443 --token <token>   # real iPhone/iPad (safaridriver)
```

Without `--server`, the gate serves `dist/` and `fixtures/local` itself on `http://127.0.0.1:4183` (`--port`), which is enough for this Mac and the Simulator. A real device needs the HTTPS disc server (`tools/disc-server`) and its token. Results go to `.superpowers/sdd/2026-10-17-m5d-bdj-menus/gate/` (`--out`), one JSON file per disc plus screenshots; tokens are never written. An A_NEW_ERA run skips with a reason where `VideoDecoder` has no HEVC. `--startup-runs n` opens the disc n more times first and records each first frame: the first open in a fresh browser is cold, and the rest are warm. The exit code is 1 when a disc fails.

Two notes on the drivers:

- Safari on the Mac needs Develop → Allow Remote Automation and an unlocked screen, because safaridriver delivers no input while the screen is locked. The gate checks for a locked screen and stops with a message. It also brings Safari to the front after each navigation.
- On a real iPhone or iPad (`ios:<udid>`), the gate uses plain `safaridriver` with the device as the target, not Appium. Web Inspector and Remote Automation must be on. iPadOS 27 has two quirks: an element click never lifts the finger, and several taps in one action list merge into one. So every tap is its own touch pointer action, followed by `DELETE /actions`.

## The 5e live check (`live-check.ts`)

This check runs on real devices against the live NAS, on a **preview** origin of the player only. The script refuses the production origin. It makes two made-up test people and pairs their devices, checks that BD-J saved data follows a person and never crosses to another, and opens the library discs the library check left unconfirmed. It deletes both people at the end, even when the run fails or is stopped with Ctrl-C.

1. **People.**
   - "Mika (test)" is made by the NAS's owner tooling over ssh (`server/deploy/deploy.sh --owner-code --person`), with a headless controller device paired the way `scripts/verify-level.ts` pairs.
   - "Sora (test)" is made by that controller's owner session (`POST admin/codes {newPerson}`), and gets a controller of its own.
   - Each browser pairs through the app's own pairing screen with a fresh code (`POST admin/codes {personId}`).
   - A browser already paired on that origin as anyone but a test person stops the run. It is never re-paired.
2. **Store** (`fixtures/synthetic/disc-bdj-store`, opened from the NAS library). Each device's count is read from the plane hash, which is libbluray's hash for that opening. Each person's NAS count is read back by that person's controller.
   - Mika's phone shows 0, and the NAS then holds 1.
   - Mika's tablet shows 1 (2 on the NAS).
   - Sora's first browser shows 0 (Sora's NAS holds 1; Mika's stays 2).
   - Sora's second browser shows 1, never Mika's 2.

   `--store-disc place` (the default) places the disc on the NAS for the run:
   - It copies the fixture (668 KB) over ssh into a new folder of its own, `<root>/zz-live-check-<run id>/disc-bdj-store`. `--place-root` names the library root (a `LIBRARY_ROOTS` name) to place it under and has no default; pick one with free space. `mkdir` without `-p`, so the folder is always new.
   - It rescans through the owner route (`POST admin/rescan`) and waits until the library lists the disc.
   - The clean-up deletes only that folder. It checks the path against the run id and the roots, and that the folder holds nothing but the disc. It then confirms the folder is gone and rescans. It waits until the disc is unlisted and the title matcher's filed and unsorted counts are back to where they were.

   `--store-disc auto` looks for a disc already in the library instead. `--rehearse-store <library path or library-check id>` runs the same steps on another disc without expecting counts, as a dry run.
3. **Library** (`--library`, Mika's phone). Each id (by default the 14 unconfirmed ones; or `--disc <id>`):
   - goes through `$BDJ_LIBRARY_DIR/map.tsv` and the roots read from the NAS (the `LIBRARY_ROOTS` line of `~/bluray-server/.env` and the bind mounts of its `compose.override.yaml`, over ssh, read-only) to its NAS library disc;
   - is opened from the NAS;
   - is driven with `tools/bdj-library/generic.keys` through the on-screen remote. The remote is opened with a tap off the picture, so the disc never sees the tap.

   A screenshot is saved after every step, to `<out>/<id>/`.
4. **Clean-up.**
   - Each browser forgets its test pairing and the test people's write-ahead records before it closes.
   - Sora, then Mika, is deleted with `DELETE admin/people/<id>`, which also clears their saved data on the NAS.
   - The NAS's people file is then read over ssh to confirm that no test person, device or saved data is left and that the other people are as before.

```sh
export LIVE_CHECK_NAS=https://<nas host>/bluray/api/   # or --nas <api base>; there is no default
npx tsx tools/devices/live-check.ts --origin https://<branch>.bluray.pages.dev --out <dir outside the repo> \
  --mika-phone ios:<iPhone udid> --mika-tablet ios:<iPad udid> --library
# dry run: Simulators for Mika, Chrome for Sora, another disc for the store steps
npx tsx tools/devices/live-check.ts --origin https://<branch>.bluray.pages.dev --out <dir> \
  --mika-phone "sim:iPhone 17" --mika-tablet "sim:iPad Air 11-inch (M4)" --rehearse-store <library-check id> --library
```

Sora's browsers default to `chrome-profile` (installed Chrome with a fresh temporary profile) and `chrome` (a second Chrome with its own context). Use `--sora-a`/`--sora-b` to change them, or `none` to leave one out. Real devices go through safaridriver on `--wd-ports` (default `4211,4212`; ports above 4200 only, never 4191/4192). Simulators go through Appium. `--out` must lie outside the repository, because the screenshots show real discs. Results (`live-check.json`) name devices by role, and pairing codes and tokens are never printed or written. The NAS's API base comes from `--nas` or `$LIVE_CHECK_NAS`, with no default: the run stops at once when neither is given. The NAS host for ssh is `$BLURAY_NAS_HOST` (no default: the run stops at once without it).

## Not here

Device UDIDs, Apple IDs, team IDs, certificates and tokens stay out of the repository: pass them on the command line or in the environment.
