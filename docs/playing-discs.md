# Playing discs

## Disc menus

Most discs open to their own menu. Blu-ray has two kinds, and the player runs both:

- **HDMV menus** (the classic kind) are drawn and run by the player. They take keys, mouse clicks and touch.
- **BD-J menus** (Java) run in the player's own Java engine and are drawn over the video. They take keys, mouse and touch too.

Discs with MPEG-2 or VC-1 video (many older discs, concerts and TV shows) play with a picture in every browser: browsers can't decode those formats, so the player decodes them itself. Interlaced ones are deinterlaced like any other (see Deinterlacing below). The decoder is downloaded the first time such a disc plays and kept for offline use after that. On a device that can't run it, such a disc plays without a picture (see [Troubleshooting](troubleshooting.md)).

If the browser cannot run BD-J (it lacks something BD-J needs), the first screen says so, and such a disc opens to a list of its playlists.

The control bar has:

- **Top Menu** and **Pop-up**, when the disc has them.
- **Remote**, an on-screen remote with arrows, OK, number keys, Top Menu and Pop-up. It is useful on a phone.
- **Titles** (HDMV) or **Playlists** (BD-J and others): choose what to play from a list. The main feature is marked.

A disc may block something at a given moment. The player then says "The disc doesn't allow this here." and the button is greyed out.

## Audio and subtitles

- **Audio** menu: pick a track. Supported: LPCM, AC-3, E-AC-3, the AC-3 core of Dolby TrueHD, and the DTS core of DTS and DTS-HD. A track the player cannot play is greyed out with its codec named. Press `A` to go to the next track.
- **Subtitles** menu: Off, each subtitle track on the disc, and any file you add. Press `S` to cycle. Forced captions show even with subtitles off.

### Disc preferences

**Disc preferences** (on the start screen, and in the player's **Settings** menu) sets what discs start with: audio language, subtitle language, menu language, country and region. Each is **Auto** until you choose:

- **Audio** and **subtitles** on Auto leave it to the disc, which usually starts in its original language. Choose a language to have discs start in it where they have it, for example Japanese audio with English subtitles.
- **Menu language** and **country** on Auto follow your browser's language.
- **Region** (A, B or C) on Auto follows the country. A disc locked to another region may refuse to play or show a region screen; set the region it was made for.

A change applies from the next disc you open; the Audio and Subtitles menus still switch tracks while one plays. Encoded episodes start on a chosen audio or subtitle language too, unless you are resuming one. With a NAS paired, your preferences follow you to every device paired as you.

### Your own subtitle files

Add `.srt`, `.ass` or `.ssa` files from the Subtitles menu (**Load subtitle files…**), or drop them on the player.

You can also pick or drop an `.mkv` file, such as a fansub release. Seikou reads only its text subtitle tracks (ASS, SSA and SRT) and the fonts attached to it, not the video, so a file on a network share is read quickly and nothing is uploaded. The track marked default loads, else the first in your subtitle language (see Disc preferences), else the first track, with the file's fonts, and the Subtitles menu lists the file's other text tracks to switch to. Picture subtitles (PGS) in an MKV aren't loaded. After that it works like any file you added: the timing shift and size apply, and the track comes back when you resume, with the file's fonts that fit in what Seikou keeps on the device (5 MB a font, 50 MB a disc).

- A text file that is not UTF-8 asks you to choose its encoding.
- ASS files use their own fonts if you add them (**Add fonts…**, or drop font files with the subtitles: `.ttf`, `.otf`, `.ttc`, `.woff`; WOFF2 fonts can't be used, so convert them to TTF or OTF first). A font the subtitles name but don't include (Arial or Times New Roman, say) is taken from your device when it has it. Computers, iPhones and iPads have the common ones (Arial, Times New Roman, Trebuchet MS, Verdana, Georgia, Courier New); Android phones and tablets usually don't. The menu lists any font that is still missing.
- Each file has a timing shift, in steps of 100 ms. `[` makes the subtitles earlier and `]` later.
- **Size** in the menu makes the text smaller or larger (50% to 200%).
- **Remove subtitle files** clears them.

### Subtitles for several episodes

You can load one file per episode and place each at where its episode starts. With several files loaded, each file has a **Start** list: an episode start, a chapter, the current position, or **Not placed**. Pick where each file belongs and the player shows the right one at the right time. Files are placed automatically on play items of five minutes or more.

### Search Anime Tosho

On a disc opened from the NAS, the Subtitles menu has **Search Anime Tosho…**. It starts from the title's name; pick a release, a file and a subtitle track, and the NAS fetches the track with its fonts and lines it up with the episode you are playing. The pick is yours alone: others don't see it. It comes back when you resume, and **Up next** carries it to the next episode when the next episode's file in the same release has a track of the same name. Otherwise Up next falls back as it does for any subtitle from the NAS: a stored subtitle in the same language, else the disc's own.

## Video shaders (Anime4K)

The **Shaders** menu applies an mpv-style video shader to make the picture sharper. Press `V` to cycle through the sets: Off, then Anime4K Mode A (HQ) and the other High-quality modes, then the Fast ones, then Off again.

- The set you choose is this device's own setting: it stays on for every disc you play here until you change it. A new device starts with shaders off, and resuming a place saved on another device doesn't switch one on.

- Anime4K's twelve modes come with the player (the Fast and High-quality sets). Nothing needs importing. A mode is downloaded the first time you pick it, then kept for offline use.
- You can add your own shader files with **Add shaders…** (a folder), **Add files…**, or an mpv `input.conf`. **Manage…** lists and removes what you added. If a file you added has the same name as a built-in one, yours is used.
- Shaders need WebGL2 in the browser. Without it the menu says "Not available on this device".
- A shader is heavy on the graphics chip. If frames are dropped, the menu shows a warning and suggests a Fast mode.
- Shaders run on the player's own canvas, so HDR video loses its HDR while a set is on (see HDR video below). Turning a set on during HDR video reopens it on the canvas at the same moment, and turning it off brings the HDR back.

## HDR video

HDR10 and HLG discs play through the browser's own video player, which shows HDR on a display that can show it. While HDR video plays on such a display, an **HDR** badge shows over the picture. Other discs play on the player's canvas as before.

- **Video output** in the control bar chooses how video is shown:
  - **Auto (HDR through the browser's video player)**, the default: HDR video goes through the browser's video player, the rest through the canvas. A disc whose video the browser can play only in its video player (HEVC in some browsers) goes there too.
  - **Always the video player**: every disc's video the browser's video player can play goes there.
  - **Always the canvas**: nothing does, and HDR video shows without its HDR.

  A change applies from the next playlist, not the one playing, and stays on this device until you change it again. Encoded episodes don't have it, since they always play on the canvas.
- A video shader set that can run here sends the video to the canvas, whatever Video output says. Video the canvas can't play here still goes to the browser's video player, without the shaders.
- Subtitles and disc menus stay at SDR brightness over HDR video for now, so beside bright highlights they can look grey. On Windows the **SDR content brightness** slider in the display's HDR settings should set how bright they look; this hasn't been checked on an HDR display yet.
- If the browser's video player can't play a disc's HDR video, the player says "HDR video couldn't play in this browser, so it shows without HDR and its colours may look flat" and plays the rest of the disc on the canvas.
- A Dolby Vision disc plays its HDR10 picture. HDR10+ discs play as HDR10.
- Firefox doesn't show HDR video; use Chrome or Safari for HDR.

## Deinterlacing

Many older discs, and most live concerts and TV shows, are interlaced (480i, 576i and 1080i): each frame holds two moments, and moving edges show combing if the frames are drawn as they are. The player removes it by itself. Live footage plays at the field rate (59.94 pictures a second for a 29.97 frame disc), so motion stays smooth. Film and anime, which discs often store as 24 pictures a second spread over interlaced frames (3:2 pulldown, hard in the video or soft in its flags), are put back together as 23.976 whole pictures a second. The player decides this by itself, scene by scene.

- **Deinterlacing** in the Video output menu has **Auto** (the default) and **Off**. Off draws the frames as the decoder gives them. A change applies at once, reopening the playlist at the same time, and stays on this device until you change it again.
- It works on the canvas path, and where the browser has WebGL2. Without WebGL2, or if the graphics chip fails during a disc, the frames are drawn as they are. On a computer that draws WebGL in software (no graphics chip, as in many virtual machines), a simpler deinterlacer runs instead: it shows every field as a whole picture, but film isn't recognised, so film discs move with a slight judder. In Firefox on a Mac, H.264 discs are deinterlaced too, with slightly softer colour around moving edges, because Firefox's decoder has already mixed the two fields' colour.
- HDR discs are never affected: UHD discs are progressive.

## Picture in Picture and fullscreen

**Picture in Picture** (the ⧉ button in the control bar, where the browser has it: Safari, Chrome) shows the video in a small window over other apps and pages. **Fullscreen** (⛶, or `F`) fills the screen with the whole player: subtitles, menus and controls.

- Picture in Picture shows the video alone: subtitles and disc menus stay on the page, and the player says so the first time. Its play, pause and seek controls drive the player, and the sound keeps playing in step.
- It needs H.264 or HEVC video. MPEG-2 and VC-1 discs, encoded episodes, and a playlist with video shaders on can't use it, and the player says why. The video output setting **Canvas** keeps it off too.
- When the video is drawn on the canvas (most H.264 discs, under Auto), the first tap moves the playlist to the video element at the same place, then opens Picture in Picture. If that takes longer than the browser allows after a tap (about a second in Safari on iPhone), the player asks you to tap Picture in Picture once more. The disc then stays on the video element until you open another.
- Where a browser can't make the page fullscreen but can show a video fullscreen (Safari on some iPhones), Fullscreen shows the video alone in the system's player, the same way, with the same limits. It waits while a disc menu is shown, and closes when a menu comes up so you can use it.

## Controls

### Keyboard

| Key | Does |
| --- | --- |
| Space | Play or pause |
| Left, Right | Back or forward 10 seconds |
| Up, Down | Volume up or down |
| `F` | Fullscreen |
| `A` | Next audio track |
| `S` | Next subtitle choice |
| `V` | Next video shader set |
| `[`, `]` | Subtitle file earlier or later by 100 ms |
| `M` | Top menu |
| `P` | Pop-up menu |

While a disc menu is shown, the arrow keys, Enter and the number keys `0` to `9` go to the menu instead.

### Mouse

Click the picture to play or pause. On a disc menu, click goes to the menu. Move the mouse to show the control bar. Over a disc menu the bar shows only when the pointer is near the bottom edge, so it does not cover the menu.

### Touch

- Tap the picture to show or hide the controls.
- Double-tap the left or right third to go back or forward 10 seconds.
- On a disc menu, a tap on the picture goes to the menu. A tap on the black bands around the picture, a tap that hits no button, or a press held for half a second shows the controls instead.
- If a BD-J menu ignores taps, the player says "This disc's menu doesn't respond to taps here. Use the remote." and opens the on-screen remote.

### Remote and media keys

The on-screen **Remote** has arrows, OK, `0` to `9`, Top Menu and Pop-up. Play, pause and 10-second skips also work from your device's media controls (lock screen, headset keys) where the browser supports them.

## Resume

A disc remembers where you stopped, per playlist. The next time you open it:

- You are asked **Resume at m:ss** or **Start from beginning**, with the device and time you stopped. On a disc, **Start from beginning** opens it as if for the first time, with its intro and menu, and forgets where you stopped, so the next open doesn't ask again. On an episode, it plays the episode from the start with the audio and subtitles you had.
- A place in the first 30 seconds (or first 5% of a short playlist) asks nothing and plays from the start. So does a place near the end: a finished playlist starts over.
- If the disc is not the same as when you stopped, only **Start from beginning** is offered ("This disc has changed since you stopped.").

The place is saved every 10 seconds while playing and when you pause, seek or close. It includes the audio and subtitle choice and the volume (not the shader set, which belongs to the device). A folder you open from your own drive keeps its place on that device. A NAS keeps places per person (see [NAS](nas.md)).

A playlist makes a place when you launched it yourself (an episode or a link), when it is the disc's main title, or when it lasts five minutes or more. Menu loops never do.
