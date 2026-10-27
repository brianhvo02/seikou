# Playing discs

## Disc menus

Most discs open to their own menu. Blu-ray has two kinds, and the player runs both:

- **HDMV menus** (the classic kind) are drawn and run by the player. They take keys, mouse clicks and touch.
- **BD-J menus** (Java) run in the player's own Java engine and are drawn over the video. They take keys, mouse and touch too.

Some discs, such as those with MPEG-2 or VC-1 video, play without a picture (see [Troubleshooting](troubleshooting.md)).

If the browser cannot run BD-J (it lacks something BD-J needs), the first screen says so, and such a disc opens to a list of its playlists.

The control bar has:

- **Top Menu** and **Pop-up**, when the disc has them.
- **Remote**, an on-screen remote with arrows, OK, number keys, Top Menu and Pop-up. It is useful on a phone.
- **Titles** (HDMV) or **Playlists** (BD-J and others): choose what to play from a list. The main feature is marked.

A disc may block something at a given moment. The player then says "The disc doesn't allow this here." and the button is greyed out.

## Audio and subtitles

- **Audio** menu: pick a track. Supported: LPCM, AC-3, E-AC-3, the AC-3 core of Dolby TrueHD, and the DTS core of DTS and DTS-HD. A track the player cannot play is greyed out with its codec named. Press `A` to go to the next track.
- **Subtitles** menu: Off, each subtitle track on the disc, and any file you add. Press `S` to cycle. Forced captions show even with subtitles off.

### Your own subtitle files

Add `.srt`, `.ass` or `.ssa` files from the Subtitles menu (**Load subtitle files…**), or drop them on the player.

- A text file that is not UTF-8 asks you to choose its encoding.
- ASS files use their own fonts if you add them (**Add fonts…**, or drop font files with the subtitles: `.ttf`, `.otf`, `.ttc`, `.woff`; WOFF2 fonts can't be used, so convert them to TTF or OTF first). The menu lists any missing fonts.
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

- You are asked **Resume at m:ss** or **Start from beginning**, with the device and time you stopped.
- A place in the first 30 seconds (or first 5% of a short playlist) asks nothing and plays from the start. So does a place near the end: a finished playlist starts over.
- If the disc is not the same as when you stopped, only **Start from beginning** is offered ("This disc has changed since you stopped.").

The place is saved every 10 seconds while playing and when you pause, seek or close. It includes the audio and subtitle choice and the volume (not the shader set, which belongs to the device). A folder you open from your own drive keeps its place on that device. A NAS keeps places per person (see [NAS](nas.md)).

A playlist makes a place when you launched it yourself (an episode or a link), when it is the disc's main title, or when it lasts five minutes or more. Menu loops never do.
