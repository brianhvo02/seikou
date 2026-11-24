# Troubleshooting

What the player says, what it means, and what to do.

## Opening a disc

**"This browser is missing: …"**
The browser lacks a feature the player needs (WebCodecs, AudioWorklet, OffscreenCanvas, or cross-origin isolation). Use a supported browser (see [Getting started](getting-started.md)) and keep it up to date. If the missing item is cross-origin isolation, the page is being served without the headers it needs; see [Self-hosting](self-hosting.md) if you host the player yourself.

**"This disc can't be played because these files are missing."**
You picked a folder without all of the disc. Choose the whole disc folder, including `BDMV/STREAM` and `BDMV/CLIPINF`.

**"Drop the disc folder itself (the folder that contains BDMV), or one .iso image."**
You dropped files and no folder. Drop the disc folder, the `BDMV` folder, or a single `.iso` image.

**"… is not a Blu-ray image" or "… can't be read as a Blu-ray image"**
The `.iso` you picked isn't a Blu-ray disc (it has no `BDMV` folder, or it isn't a UDF image), or it was cut short while copying. Copy it again, or open the disc folder instead.

**"… has a file this player can't read"**
A file in the image has a long unrecorded stretch the player won't fill in. Extract the image to a folder and open that.

**"Waiting for the files…" on iPhone or iPad**
Safari copies the whole folder before the player can read it. A full disc from a USB drive can take an hour or more. The player needs the whole disc folder, so copy it to faster storage first, or use a [NAS](nas.md).

**"Permission to read … was not granted."**
For a disc in Recent discs, the browser asked for permission and it was refused. Choose the folder again.

## Picture and sound

**"This disc's video can't be played here yet, so it will play without a picture."**
The disc's video is MPEG-2 or VC-1, which browsers cannot decode, and the player's own decoder for them couldn't start on this device or failed on this disc (the browser can't start it, or it is offline and the decoder was never downloaded: play such a disc once while online and it is kept). Sound, subtitles and menus still work over black. The notice shows once per disc and clears when something with a picture starts. On a NAS with quality levels, a level that re-encodes the disc gives a picture.

**An MPEG-2 or VC-1 disc stutters, or its picture lags behind the sound**
The player decodes these formats itself, on the device's processor. A slow device skips some pictures to keep up. On a NAS disc the player switches to a re-encoded level by itself when its decoder fails or can't keep up; for a local folder, close other tabs, or play the disc from a NAS with quality levels.

**Moving edges show combing (fine horizontal lines)**
The disc is interlaced and is drawn as it was recorded: Deinterlacing is Off, the browser has no WebGL2, or the graphics chip failed. Set **Deinterlacing** to **Auto** in Video output, or see [Deinterlacing](playing-discs.md#deinterlacing).

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

**HDR video looks dim or flat, or shows no HDR badge**
The badge shows only while HDR video plays on a display that can show HDR. Turn HDR on in the display's or the system's settings (on Windows, **Use HDR** in the display settings), and keep the window on that display. Firefox doesn't show HDR video; use Chrome or Safari. HDR also goes when a video shader set is on or **Video output** is **Always the canvas**, since the player's canvas has no HDR; see [HDR video](playing-discs.md#hdr-video).

**Subtitles or menus look grey, or too bright, beside HDR video**
Over HDR video on a display that shows HDR, the player draws subtitles and disc menus brighter, where the browser has WebGPU; without it they stay at the page's white and can look grey beside bright highlights (on Windows, the **SDR content brightness** slider in the display's HDR settings sets that white). Their brightness over HDR video hasn't been checked by eye on an HDR display yet; see [HDR video](playing-discs.md#hdr-video).

**"HDR video couldn't play in this browser, so it shows without HDR and its colours may look flat"**
The browser's video player failed on this disc's HDR video, so the disc plays on the player's canvas, without HDR, until you open another disc. Update the browser, or try another one.

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
