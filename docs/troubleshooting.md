# Troubleshooting

What the player says, what it means, and what to do.

## Opening a disc

**"This browser is missing: …"**
The browser lacks a feature the player needs (WebCodecs, AudioWorklet, OffscreenCanvas, or cross-origin isolation). Use a supported browser (see [Getting started](getting-started.md)) and keep it up to date. If the missing item is cross-origin isolation, the page is being served without the headers it needs; see [Self-hosting](self-hosting.md) if you host the player yourself.

**"This disc can't be played because these files are missing."**
You picked a folder without all of the disc. Choose the whole disc folder, including `BDMV/STREAM` and `BDMV/CLIPINF`.

**"Drop the disc folder itself (the folder that contains BDMV)."**
You dropped files and no folder. Drop the disc folder, or the `BDMV` folder.

**"Waiting for the files…" on iPhone or iPad**
Safari copies the whole folder before the player can read it. A full disc from a USB drive can take an hour or more. The player needs the whole disc folder, so copy it to faster storage first, or use a [NAS](nas.md).

**"Permission to read … was not granted."**
For a disc in Recent discs, the browser asked for permission and it was refused. Choose the folder again.

## Picture and sound

**"This disc's video can't be played here yet, so it will play without a picture."**
The disc's video is MPEG-2 or VC-1, which browsers cannot decode. Sound, subtitles and menus still work over black. The notice shows once per disc and clears when something with a picture starts. On a NAS with quality levels, a level that re-encodes the disc may give a picture.

**"This device can't decode HEVC (4K) video."**
The disc's video is HEVC and this device cannot decode it. Try another browser or device.

**"Audio output could not start: …" or "Audio output is not available, so video will play without sound."**
Browsers start audio only after you click or tap. Click Play or the picture, or reload the page and open the disc again. Check the device is not muted and has an output. Video plays without sound meanwhile.

**An audio track is greyed out ("… isn't supported")**
The player plays LPCM, AC-3, E-AC-3, the AC-3 core of TrueHD and the DTS core of DTS and DTS-HD. Pick another track.

**"Playback paused while the app was in the background."**
The player pauses itself when the device suspends or interrupts its audio, for example in the background or during a call. Come back and press Play.

**Frames are dropped with a shader on**
The Shaders menu shows a warning. Try a Fast mode, or turn shaders off.

**"Shaders are unavailable here" or "Not available on this device"**
The browser does not give the player WebGL2 render targets. Shaders cannot run on this device.

## Disc menus

**"This disc uses BD-J (Java) menus, which this browser can't run: it lacks …. Choose a playlist to play."**
The browser lacks something BD-J needs. Pick a playlist from the list, or use a browser that has it.

**"BD-J couldn't start this disc (…). Choose a playlist to play."**
The disc's Java menu failed to start, or did not start within 20 seconds of active time. Choose a playlist to play. Opening the disc again sometimes works. If a disc always fails, its Java program may need something the player does not provide.

**"This disc's menus need more memory than this device allows."**
A large menu does not fit in this device's memory. Use a desktop browser, or pick a playlist.

**"This disc's menu doesn't respond to taps here. Use the remote."**
A BD-J menu ignored a tap. Tap **Remote** in the control bar and use its arrows and OK.

**"The disc doesn't allow this here."**
The disc blocks that action at this moment (for example skipping a warning). Wait for the part to end.

**"This disc's saved data can't be kept right now, so progress you make may be lost."**
A BD-J disc saves things such as scores or settings. This device could not keep them (no room, or the NAS refused). It shows once per disc. Free some space on the device and open the disc again.

## Subtitles

**"… this file has no subtitles we can read"** or **"Some lines of this file could not be read"**
The file is empty, not a subtitle file, or in a different encoding than chosen. Add it again and choose another encoding if asked.

**"Some fonts are missing and were replaced: …"**
An ASS file wants fonts you have not added and your device doesn't have installed. Use **Add fonts…** in the Subtitles menu.

**"Place each subtitle file at its episode's start in the subtitle menu"**
You loaded several files. In the Subtitles menu, set each file's **Start**.

## NAS

**"This device is no longer paired with the NAS."**
The owner removed this device from the NAS, or its pairing no longer works. Pair again with a new code or invite (see [NAS](nas.md)).

**"That code didn't work. Codes last 10 minutes; ask for a new one."**
The code expired, was already used, or was mistyped. Ask for a new one. After too many tries, "Too many tries. Wait a minute and try again."

**"This NAS isn't reachable from here yet."** or **"Couldn't reach the NAS. …"**
The NAS may be off, or this device is not on the right network. If your browser asked about local network access, allow it (in the browser's site settings if you declined). If you reach the NAS over Tailscale at home, being on the tailnet gives the direct route. Away from home the player tries WebRTC instead.

**"Connection to the NAS lost."**
Reopen the disc. Playback resumes where it stopped if you choose Resume.

**"This disc changed on the NAS. Open its folder again."**
Files on the NAS changed while you watched. Open the disc again.

**"Waiting for the NAS drive…"**
A read from the NAS has taken about 3 seconds, at the start or during playback, for example while a sleeping drive spins up. Give it a moment.

**"The NAS is busy re-encoding for others. This will play at original quality." / "The NAS is busy. Try again in a few minutes."**
The NAS's graphics card has no room for another re-encode. Play at Original, or try later.

**"Couldn't buffer on this device, so it will play with pauses."**
Buffering ahead stopped early: the device's storage is unavailable, a read or write failed, or there is no on-device cache. The disc plays with pauses. A lower quality level needs less data. (If the device only lacks room, the pre-flight says so in other words and offers **Play now with pauses**.)

**"The library is being prepared"**
The NAS is still matching its discs to titles. Check again later, or use **Browse by folder instead**.

**A link says the NAS does not have what it points to**
The disc may have been removed or renamed, or the link is for another NAS. Go back to the library.

## Still stuck

Reload the page. If a new version is ready, the bar says "A new version is ready." with **Reload**. For problems with a server you run, see [Self-hosting](self-hosting.md). Bugs can be reported on the project's GitHub page.
