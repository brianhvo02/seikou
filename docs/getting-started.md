# Getting started

Seikou opens a decrypted Blu-ray folder in your browser. Nothing is uploaded: the disc is read on your device.

The player's address is now `bluray.pages.dev`; it used to be `bluray-web.pages.dev`, which is gone. What a browser keeps (NAS pairings, recent discs, the places of local discs, imported shaders, disc saves from a local folder) stayed with the old address, so pair again at the new one. Places and disc saves kept on a NAS belong to your person there and come back once this device is paired as you again; ask the NAS owner for a code for your person if you can't make one yourself.

## Browsers

| Browser | Supported |
| --- | --- |
| Safari 26 on macOS, iOS and iPadOS | Yes |
| Chrome and Firefox on desktop (current release and the two before it) | Yes |
| Chrome on Android | Yes |
| Firefox on Android | No |

Other Chromium browsers such as Edge may work but are not tested.

The player needs WebCodecs, AudioWorklet and a few other modern features. A browser without them shows "This browser is missing: …" on the first screen and the Open button stays off.

## Light and dark

The switch at the top of the page, beside **Help**, sets the look: **Auto** follows your device's light or dark setting, **Light** and **Dark** keep one look whatever the device says. On a phone it shows as three icons. The choice is kept on this device only, and a new device starts on Auto. The player itself is always dark, so the page turns dark while a disc is open and back when you close it.

## Open a disc

You need a Blu-ray disc as a folder, already decrypted (the player does not remove copy protection). The folder is the one that contains `BDMV`. The `BDMV` folder itself works too.

1. Open the player and choose **Open disc folder**, or drag the folder onto the page.
2. Pick the whole disc folder, including `BDMV/STREAM` and `BDMV/CLIPINF`. If files are missing the player lists them.
3. The disc's own menu appears, as it would on a player. If the disc has no usable menu, you get a list to choose from (see [Playing discs](playing-discs.md)).

Notes:

- Dropping a folder needs a browser that supports it. If a drop is refused with "Drop the disc folder itself (the folder that contains BDMV).", drop the folder, not a file inside it.
- On iPhone and iPad, Safari copies the whole folder before the player can read it. A full disc from a USB drive can take an hour or more, and the page says "Waiting for the files…" meanwhile.
- Pick a folder, not an `.iso` file. A NAS can serve `.iso` discs (see [NAS](nas.md)).

## Recent discs and resume

Chrome (and other browsers that let sites keep folder permissions) list **Recent discs** on the first screen. A disc you stopped part-way shows "Resume at m:ss". Choosing it offers **Resume** or **Start from beginning**.

Safari and Firefox do not keep folder permissions, so you pick the folder each time. Safari also clears a site's data after 7 days without a visit, which would clear your saved places. Adding the player to your Home Screen or Dock avoids that, and the first screen reminds you.

## Install the app

The player installs as an app (a "progressive web app"):

- Chrome on desktop and Android: use the install option in the browser's menu or address bar.
- Safari on iPhone and iPad: Share, then **Add to Home Screen**. Fullscreen on iPhone also needs this.
- Safari on Mac: File, then **Add to Dock**.

## Offline use

After the first visit the player works with no network: the app is cached, and a disc folder is read from your own drive. When a new version is downloaded, a bar says "A new version is ready." with a **Reload** button. It waits until nothing is playing.

A few things need a network: a NAS, and the first use of a built-in video shader (see [Playing discs](playing-discs.md)). After that, the shader is kept for offline use.

## Next

- [Playing discs](playing-discs.md): menus, tracks, subtitles, shaders, controls.
- [NAS](nas.md): play from a server that holds your library.
- [Troubleshooting](troubleshooting.md)
