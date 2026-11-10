# NAS

A NAS server (see [Self-hosting](self-hosting.md)) holds your discs and serves them to the player. You pair a device with it once. After that you browse a library, play, and pick up where you stopped, from any paired device.

This page is for people who use a NAS. Someone else usually runs it and gives you a code or link.

## Pair a device

You need a pairing code or an invite link from the NAS owner.

- **Code:** on the first screen, type the code (it looks like `XXXX-XXXX-XXXX`), give the device a name, and choose **Pair**. A code lasts 10 minutes. If it says "That code didn't work. Codes last 10 minutes; ask for a new one.", ask for another.
- **Link or QR:** open the link, or scan the QR code with your phone's camera. The player opens with the code already filled in. Choose **Pair** to finish. If the link names a server or pairing service other than the player's own, the player first asks you to confirm it ("This link pairs with: … Only continue if you trust them."). An invite lasts 3 days.
- If your browser asks about **local network access**, allow it. Pairing waits until you answer. If the NAS is reached over Tailscale at home, being on the tailnet gives the direct route. Without it the player falls back to WebRTC.

When paired, the first screen shows who you are paired as, with **Open from NAS** and **Forget this NAS**. While you browse the NAS, that line moves to the foot of the page, and **Open disc folder** stays in the bar at the top, beside **Help**. A device can be paired with one NAS at a time: pairing again replaces it.

"Use another rendezvous" under the code field is for a NAS that runs its own pairing service. Most people never need it.

## The library

**Open from NAS** shows the **Library**:

- A search box (English, romaji or Japanese titles).
- **Series**, **Movies** and **Music** shelves, with a letter index to jump along a long list.
- **Continue watching** and **Recently added** on the front page.
- **Browse by folder instead** at the bottom, for discs the NAS has not filed under a title.

The NAS files each disc under a title by itself. A series has seasons, each with an **Episodes** tab and a **Discs** tab, plus **Extras**. A watched mark shows how far you are in each episode.

If the owner has not opened the library to everyone, you see the folders only. Owners also see an **Unsorted** shelf (discs the NAS could not file) and a settings button.

## Encodes

The **Encodes** tab, beside **Discs** on the NAS screens, lists episodes encoded with the Seikou encoder: one MKV file per episode, with AV1 video, Opus audio, ASS and PGS subtitles, and named chapters. Episodes are grouped by show, using AniList: a show's seasons, then its films and other entries. **Continue watching** and **Up next** on this tab work as they do for discs, and places on encodes are kept apart from places on discs.

### Setting it up (owner)

Set `ENCODES_MOUNT` in the NAS's `.env` to a folder on the host and redeploy (see [Self-hosting](self-hosting.md)). Without it the tab shows "No encodes yet" and a link here. Episodes reach the folder in two ways:

- **Uploaded from the encoder.** Pair the Seikou encoder with the NAS as an owner device: make an owner pairing code in the admin screen and type it on the encoder's **Settings**, under **Your NAS**, with the NAS's address (`https://…/bluray/api/`), or paste the pairing link. The encoder then lists the NAS's discs in its library beside its own, marked NAS, and fetches only what it works on. On its **Episodes** page, choose each episode's AniList entry and number; then, when you queue the encode, choose **The NAS (Encodes library)** as where the episodes go. Each episode is uploaded as soon as it is encoded and removed from the encoder's computer once the NAS has filed it. The upload goes over HTTPS (not over the WebRTC route) and can resume after a break, and the NAS checks the file's size and hash before filing it as `<AniList id>/<episode>.mkv`. Uploading the same episode again (a re-encode) replaces the old file once the new one is complete.
- **Placed by hand.** Copy MKVs the encoder wrote into the folder. The NAS reads their tags when it starts, looks at the folder again every 10 minutes, so files you copy in appear without a restart, and keeps an index.

The NAS reads each file's tags: the AniList id, the episode number, the episode title, and the disc and playlist it was encoded from. A file without an AniList id is listed under **Not filed**, for owners only. Uploads are refused while the folder is missing (a drive that isn't mounted, say).

Reading the folder never moves or deletes anything. An owner's **Delete** on an episode removes that episode's file from the folder. If another copy of the same episode is still in the folder, that copy is listed next.

### Watching

Choosing an episode opens a short pre-flight with **Play**, or **Resume at m:ss** and **Start from beginning** if you stopped part-way. In the player:

- **Chapters** in the control bar lists the episode's chapters by name and jumps to one.
- **Skip opening** shows during a chapter named Opening and jumps to the next chapter. **Skip ending** does the same during an Ending that has more after it.
- **Next episode** shows during an Ending that nothing follows, or during a Preview after the Ending, and at the end of the episode. It opens the next episode of the show (the next number in the same season or entry, then the next season; never after a film), keeping your audio and subtitle choices by language. There is none after the show's last episode.
- **Next episode countdown** in the player's **Settings** menu starts the next episode by itself after 10 seconds. The bar drains as it counts, and **Cancel** stops it. The setting is yours and follows you to your other devices.
- **Subtitles** offers the episode's own tracks, subtitles stored on the NAS for the disc and playlist the episode came from (see below), **Search Anime Tosho…**, and your own files.

### Devices that can't play AV1

Encodes use AV1 video, decoded by the browser. Current Chrome, Edge and Firefox decode it. Safari decodes it only on devices with AV1 hardware: iPhone 15 Pro, Macs with an M3 chip, and later. On a device without it the player says so and opens nothing; the NAS doesn't convert encodes for such devices.

## Playing

Choosing a disc opens a pre-flight screen. It measures your connection and shows:

- **Resume at m:ss** and **Start from beginning**, if you stopped part-way (see [Playing discs](playing-discs.md)).
- A **Quality** list, when the NAS can re-encode (below).
- **Play**, or, when your connection is slower than the disc needs, what to do about it.

### Slow connections

The player compares your connection with what the disc needs:

- Fast enough: **Play** starts at once.
- A short wait: it buffers silently, then plays.
- A longer wait: it says "About N minutes before it can play straight through" and offers **Wait** or **Play now with pauses**.
- If the device cannot hold enough ahead, it says so and offers only **Play now with pauses**.

While waiting you see "Buffering… N%". You can switch to **Play now with pauses** at any time.

### Quality levels

If the NAS has a graphics card for it, it can re-encode a disc to a lower quality as you watch. The Quality list can offer **Original**, **1080p**, **1080p HEVC**, **1080p HDR**, **1080p SDR** and **Phone** (720p), each with a note such as "plays now", "about N minutes" or "plays with pauses". A level your browser cannot play is greyed out with the reason. Phones and small screens start on **Phone**.

During playback the **Quality** menu switches level at the same place. A badge reads `<level> · re-encoded on the NAS`. If the NAS is busy re-encoding for others, the player says "The NAS is busy re-encoding for others. This will play at original quality." or "The NAS is busy. Try again in a few minutes."

The audio track menu on a re-encoded level reopens the level with that track.

## Continue watching and Up next

Places are saved per person on the NAS, so each paired person has their own. **Continue watching** at the top of the library shows each unfinished disc and an **Up next** card for the episode after the last one you finished. Episodes show how far you are. Opening a disc offers Resume as described in [Playing discs](playing-discs.md).

## Music

The **Music** shelf lists artists. An artist has releases, and a release opens like any other disc. A release with several discs opens its title page, listing them, first. The letter index works here too.

## Subtitles stored on the NAS

The owner can upload `.srt` and `.ass` files, with their fonts, to the NAS and attach them to an episode or to one chapter of a playlist. In the player's **Subtitles** menu, a **From the NAS** group lists the ones for what you are playing, with their language. Pick one and it loads like a file you added yourself. A stored subtitle you used comes back when you resume a disc.

An encoded episode offers the stored subtitles of the disc and playlist it was encoded from: one attached to its episode, moved to the episode's start, and one attached to the chapter the episode starts at. Others are not offered. A stored subtitle or Anime Tosho pick you used on an encode comes back when you resume it, and **Next episode** and **Up next** pick the same language (or the same release's track) for the next episode.

Owners upload from a season or movie screen. A file must be an `.srt`, `.ass` or `.ssa` up to 5 MB.

## Fansubs

The NAS can find fansub subtitles for your discs, as ranked by SeaDex (seadex.moe) and extracted by Anime Tosho (animetosho.net), line them up with your own disc's audio and attach them to the episodes for everyone paired. Owners only start it; viewers just pick the result in the **Subtitles** menu, in the **From the NAS** group.

- On a season or movie screen an owner presses **Find fansubs** (**Find fansubs again** once it has run). The NAS works through the title's seasons, fetches the chosen release's subtitle tracks and fonts, and lines each episode up. It runs one title at a time.
- Each episode row shows a mark for what was found: **lined up** (with the shift it took, such as **lined up · +1.2 s**, when there was one), **split at m:ss · check** (the timing changes partway through, worth a look), **no fonts** (the release carried none, so the text shows in a default font), **couldn't line up · set by hand**, **lined up on another disc** (the episode now plays from a different disc than the one the track was lined up on), or **not found**. The row itself plays. The **Fansubs for episode N** button beside it opens a panel with the episode's tracks: **Line up again**, **Use original timing** (the track as released, with no alignment) and a timing offset.
- Running again keeps your edits. Tracks you deleted stay deleted unless you answer yes to **Bring back the tracks you deleted?**.
- A nightly pass does the same for titles with none yet. It only runs at night: it starts if the scan ends at 18:00 or later, or before `FANSUB_WINDOW_END` (08:00 by default), and stops at that time. It pauses while a disc is being read or a quality level is encoding. A title where nothing was found is tried again after 30 days; one that hit a service error, the next night.
- **Fansub languages** on the admin screen sets which subtitle languages are kept. English is always included.

Anime Tosho skips most torrents over 25 GB and never mirrors private trackers, so a title can come back with nothing.

## Playing from outside the home

The player first tries the NAS's HTTPS address. If that fails within 2 seconds it connects over WebRTC, which needs nothing installed and works from another network (mobile data too).

If a direct connection fails altogether, the owner can turn on a Cloudflare relay in **NAS settings**, under **Relay**. While you watch over it, a "Relayed" badge shows. It is off until the owner enables it, it stops at the free monthly allowance unless the owner allows paid use, and an owner sees that month's usage there.

## Links

A link to a title or an episode opens it on a paired device. A link the device cannot open says why: "This link is for a NAS this device isn't paired with. Ask its owner to send you an invite.", or that the NAS does not have it, or that the owner has not opened the library to this device (you can still browse by folder).

## If something goes wrong

See [Troubleshooting](troubleshooting.md): a device that is no longer paired, a lost connection, a busy NAS.
