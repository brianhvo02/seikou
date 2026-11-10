# Encoder Library by show: Design notes (paused)

Date: 2026-11-10
Status: **Paused mid-brainstorm, at the user's request ("defer this for another job").** Not a finished design and not approved for planning. Pick it up by finishing the brainstorm (the open questions below), then the builder check, then the user's approval.
Parents: `2026-11-08-encoder-nas-design.md` (NAS discs in the Library, the NAS destination), Seikou's NAS title library (`docs/superpowers/specs/2026-10-17-nas-library-titles-design.md`).

## 1. Intent (the user's words where quoted)

Today the encoder's Library lists NAS discs by folder path. The user wants it to use the NAS's own title library, where discs are already sorted into shows, seasons and episodes (with their playlists) and matched to AniList. They open the Library looking for "all the above": a particular show, a season not yet encoded, "and shows I might not have sorted yet". Asked what should happen after picking a season: "I just want to encode them." Asked whether to trust the NAS's episode list or check it: "I need to check first."

## 2. What was played back and accepted ("Looks good")

A mockup (encoder colours, made-up shows) was shown and accepted ("That looks good"), then this description ("Looks good!"). Items marked *(guess)* were Claude's guesses in the playback, not yet confirmed one by one.

- **Library by show.** The Library opens by show: poster, seasons and films, disc count, and how much is already encoded (from the NAS's Encodes library). A switch keeps the by-folder view and the discs on this Mac.
- **A season, disc by disc.** Each disc lists its episodes as Encoded or To encode. "Encoded" means already in the Encodes library *(guess: matched by AniList entry and episode number)*.
- **Check before queueing.** Each disc with episodes to encode has "Check episodes", which opens the existing Episodes page with the NAS's grouping and AniList numbers filled in, to confirm or fix. A checked disc stays checked *(guess: until changed)*. Queue stays disabled until every such disc is checked.
- **Queue.** Queues only the episodes not yet encoded, to the NAS, one job per disc *(guess)*.
- **Unsorted discs.** Their own group at the bottom, opened as discs open today.
- **Optional extras.** Chapter names and subtitles stay optional, as now.
- *(guess)* Discs that give each episode its own playlist (rather than one playlist cut at chapters) are still checked per disc and queued one job per playlist.

## 3. Open questions for the rest of the brainstorm

- Whether "checked" survives a regrouping, and where it is stored (with the chapter names and AniList choices per disc and playlist is the obvious place).
- Films and OVAs within a show: same disc-by-disc check, or something lighter.
- How the NAS's episode-to-playlist map becomes the Episodes page's chapter grouping when one playlist holds several episodes (the NAS knows episodes per playlist, the encoder groups chapters).
- Whether the NAS's AniList match is the default only, or also locks the entry.
- What the "This Mac" view looks like next to "By show" and "By folder".
- What the NAS API offers for the encoder's purposes (`GET titles`, `titles/<id>`, `encodes/shows`), and whether an owner-only endpoint is needed.

## 4. Mockup

`.superpowers/brainstorm/25830-1794293197/content/library-by-show.html` (local, not committed): the Library by show and a season disc by disc.
