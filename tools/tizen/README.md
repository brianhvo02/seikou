# Samsung TV (Tizen) wrapper

`make-wgt.sh` builds a hosted Samsung TV web app: a signed `.wgt` holding only a `config.xml` and an icon, whose
`<content src>` is a page of the player on its own server. The page arrives with that server's headers, so the TV
gets the COOP and COEP headers that SharedArrayBuffer needs, if its web engine honours them in an app (the first
thing the probe answers). Nothing is installed on the TV but the wrapper: a new deploy of the page reaches the TV on
its next start.

The first use is the device probe (`probe.html`) on a 2025 Samsung TV (Tizen 9, Chromium M120). On a TV the probe
has no folder picker, so it pairs with the NAS by code and lists the NAS's folders and discs, moved through with
the remote's arrow keys. It adds four checks for TVs: `cross-origin-isolated`, `device` (cores, memory, screen,
whether the `tizen` and `webapis` globals are there), and `decode-rate-h264` and `decode-rate-hevc`. Each decode
check reads ten seconds of the disc's largest clip of that coding into memory, then decodes it twice through
WebCodecs, once on its own and once drawing every frame onto a 1920×1080 canvas as the compositor does. It passes
when decoding and drawing runs at 1.25 times the clip's frame rate or more. The results show beside a QR code of
them, for reading off the TV with a phone.

## Setting up (once)

You need a Samsung account and the TV on the same network as the Mac.

1. **Install the tools.** In VS Code, install the **Tizen TV** extension (publisher `samsungtvsdk`); it installs
   the base **Tizen** extension with it. In the Tizen activity bar open **Packages → Advanced** and install the
   newest **TV extension** and the **Samsung Certificate Extension**. Then run **Tizen: Install Tizen CLI** from the
   Command Palette. The CLI and `sdb` are installed under a Tizen folder, usually `~/tizen-studio/`
   (`tools/ide/bin/tizen` and `tools/sdb`); put both folders on PATH:

   ```sh
   export PATH="$HOME/tizen-studio/tools/ide/bin:$HOME/tizen-studio/tools:$PATH"
   tizen version && sdb version
   ```

   Tizen Studio (Samsung's older IDE) works too: its Package Manager installs the same pieces, and its CLI is in the
   same place.

2. **Turn on Developer Mode on the TV.** Find the Mac's LAN address (`ipconfig getifaddr en0`). On the TV open
   **Apps**, then **App Settings** (the exact place moves between model years), and type
   **1 2 3 4 5** on the remote's number pad (or the on-screen keypad). In the popup switch **Developer mode** to
   **On**, enter the Mac's address as the **Host PC IP**, press **OK**, and restart the TV by holding the power
   button until the logo shows. **Develop Mode** then shows at the top of Apps. Only that Mac can install apps; to
   use another, enter its address instead. Turning Developer Mode off removes the apps installed this way.

3. **Connect to the TV.** Find the TV's address (Settings → Connection → Network → Network Status → IP Settings),
   then:

   ```sh
   sdb connect <tv-ip>      # port 26101 is implied
   sdb devices              # lists it as <tv-ip>:26101 with its model name
   ```

   In VS Code's Tizen extension, **Connect Device** does the same.

4. **Make a certificate profile.** A TV runs only apps signed with a Samsung certificate made for it. In VS Code,
   Tizen extension → **Actions → Create Certificate**: give the profile a name (say `seikou`), choose **Create
   Samsung Certificate**, fill in the author details (any name; a password you will reuse), choose the **Public**
   privilege level, tick the connected TV's **DUID** (the TV must be connected, step 3), and sign in to your
   Samsung account when asked. The profile is tied to this TV: another TV needs its DUID added to the distributor
   certificate. `tizen security-profiles list` shows the profiles the CLI sees.

## Building and installing the probe

```sh
tools/tizen/make-wgt.sh --profile seikou --url https://<branch>.bluray.pages.dev/probe.html
sdb devices                                   # the serial, such as 192.168.1.50:26101
tizen install -s <serial> -n "Seikou probe.wgt" -- .cache/tizen/SeikouPrb1
tizen run -s <serial> -p SeikouPrb1.Probe
```

`--url` defaults to `https://bluray.pages.dev/probe.html`. A branch's preview (`gh workflow run preview.yml --ref
<branch>`) is at `https://<branch>.bluray.pages.dev/`, which the NAS's CORS rule allows like the main site. The URL
must be HTTPS: a page on plain HTTP is never cross-origin isolated. The wrapper's package id is `SeikouPrb1` and its
app id `SeikouPrb1.Probe`; `--package`, `--app` and `--name` change them, so a second wrapper (the player itself,
`--url https://bluray.pages.dev/ --package Seikou0001 --app Seikou --name Seikou`) can sit beside it. Installing a
newer build of the same package replaces the old one. The app also shows under **Apps** on the TV.

On the TV:

1. Choose **Use a disc on the NAS** (OK on the remote presses a button; the arrows move between buttons).
2. Type a pairing code. Mint one with `server/deploy/deploy.sh --owner-code --person "TV probe"` (or a guest code from
   NAS settings → People) and type it with the TV's on-screen keyboard. The pairing is kept in the page's origin, so
   the next run skips this step, and the player opened through the same origin finds it too.
3. Walk to a disc and press OK on it. A large H.264 Blu-ray tells the most; run it once more on a UHD (HEVC) disc.
4. Wait: the decode checks can take a few minutes on a slow TV. Read the results off the QR with a phone camera,
   or from the screen.

The QR holds only the checks' names, results and details (clip numbers, codecs and rates), never a disc's name.

## Debugging

`tizen run` starts the app; to see its console, start it in debug mode instead, which prints a port to open in
Chrome's DevTools:

```sh
sdb -s <serial> shell 0 debug SeikouPrb1.Probe   # prints a port, such as 7011
sdb -s <serial> forward tcp:7011 tcp:7011
# then open chrome://inspect in Chrome, Configure… → add localhost:7011, and inspect the page
```

The VS Code extension's **Debug Project** does the same against a project folder. `window.__probeResults` holds the
results there, as in `tools/devices/probe.ts`.

## Troubleshooting

- **`install failed[118, -12]` or a certificate error (1010):** the profile wasn't made for this TV's DUID, or a
  different profile is active. Make the certificate with the TV connected and pass that profile to `--profile`.
- **`sdb connect` times out:** Developer Mode isn't on, the Host PC IP isn't this Mac's current address, or the TV
  wasn't restarted after setting it.
- **The app opens a blank or error page:** the TV can't reach the URL. Open the URL on another device first, and
  check the widget's `config.xml` under `.cache/tizen/<package>/`.
- **`cross-origin-isolated` fails:** the TV's engine didn't isolate the hosted page. The wrapper would then have to
  carry the player itself (a packaged app) with whatever headers the TV's app runtime offers, which is the next thing
  to try.
