# Developer site: the look

Status: design plan, 2026-11-10. Built as `vite/devsite/site.css`, with the static mocks in `vite/devsite/__fixtures__/mock*.html`, whose markup is the contract the page templates follow.
Related: `2026-11-07-developer-site-design.md` §4 (Look) and §7.1 (Theme).

## 1. The brief

- **Subject.** A reference for developers who embed a Blu-ray player in a page or read the Blu-ray formats in TypeScript: eight packages (`@seikou/bdmv`, `pg`, `ass`, `engine`, `matroska`, `nas`, `titles`, `fansubs`), each export on its own page, each function with an example the tests run.
- **Audience.** TypeScript developers who already know what they want to call and need the exact shape of it. They arrive from a search result, a link in an issue or the integration guide, and leave with a signature and a working snippet.
- **Primary job.** Find an export, read its exact signature, its units and what it throws, and copy a working example. Code is the main content: signatures, type links and example blocks get the most care; prose sits beside code, never in front of it.
- **Given.** Seikou's tokens (`src/ui/tokens.css`), Instrument Sans with its width axis, the player's theme switch and its `bluray-web:theme` key, pages readable without JavaScript, everything same-origin (`require-corp`), a quality floor of 375 px, visible focus, reduced motion and light contrast of 4.5:1 for text and 3:1 for control edges.

## 2. Tokens

### Colour

No new colour. Every colour in `site.css` is a `var()` of a token in `tokens.css`, so the light values are the ones `theme-contrast.test.ts` already checks; `vite/devsite/site-css.test.ts` fails on a colour literal in `site.css`.

| Name | Dark | Light ("Paper") | Role here |
| --- | --- | --- | --- |
| Night `--night` | `#0a1330` | `#f6f8fe` | The page ground. |
| Well `--night-deep` | `#070e26` | `#eef2fc` | Signatures and example code: code sits lower than the page, a pressed well, not a raised card. |
| Ice `--ice` | `#edf1ff` | `#0a1330` | Text, identifiers in code. |
| Mist `--mist` | `#9eaad6` | `#4d5a86` | Secondary text, keywords and punctuation in code, comments. |
| Laser `--laser` / `--laser-strong` | `#5b8cff` / `#7ba3ff` | `#2f62e8` / `#2453cf` | The one accent: links, type links in code, the focus ring and the read head (§5). |
| Edge `--control-rim` | `#24356f` | `#7a88b8` | The edge of a code well, the search field and the theme switch (3:1 in light). `--rim` draws only separators that carry no meaning of their own (table rules, the bar's foot). |

Two more tokens appear in small places: `--selected` under the row the read head lights, and `--green` for string literals in code (checked at 4.5:1 on every light ground). The logo's violet and cyan stay on the player's home disc; they do not appear here.

### Type

- **Instrument Sans Variable** (bundled, OFL, through `@fontsource-variable/instrument-sans/wdth.css`, as the player loads it) sets every word that is not code. Headings and export names use its condensed width (`font-stretch: var(--narrow)`, 650), as the player's titles do.
- **Code: the system's monospace**, named in `--code`: `ui-monospace, 'SF Mono', SFMono-Regular, 'Cascadia Mono', 'Cascadia Code', Consolas, 'JetBrains Mono', 'Noto Sans Mono', 'DejaVu Sans Mono', Menlo, monospace`. Chosen, not defaulted: it costs no bytes and no request, it is the face each reader's editor already shows (SF Mono on Apple devices, Cascadia or Consolas on Windows, DejaVu or Noto on Linux), and its contrast with Instrument Sans is wide enough that code never reads as prose. A bundled mono webfont (JetBrains Mono, IBM Plex Mono) was weighed and left out: it would add 100 KB or more for every page, make every signature render twice while it loads, and give the site a second typographic personality competing with Instrument Sans. `--mono` in `tokens.css` stays the player's.
- **Scale** (16 px root, a major third, 1.25): 0.8 rem (nav headings, file names), 0.875 rem (code in blocks, 14 px), 1 rem (prose and the signature on a phone), 1.0625 rem (the signature on a wide screen), 1.25 rem (h3, member names), 1.56 rem (h2), 2.44 rem (h1, clamped down to 2 rem on a phone). Prose at line-height 1.65 and at most 72 characters a line; code at 1.6; headings at 1.15.
- Weights: 400 prose, 550 navigation and labels, 600 identifiers declared in a signature, 650 headings.

### Space and shape

A 4 px step: 4, 8, 12, 16, 24, 32, 48, 64. Radius `--r-m` (10 px) for code wells, `--r-s` (6 px) for inline code and nav items, 999 px for the theme switch, as the player draws it. No shadows: the wells are set by tone and edge.

## 3. Layout

One column of content, left aligned, with the package navigation to its left on a wide screen and after it on a narrow one. Prose is capped at 72 characters; code wells take the content column's full width (up to 880 px), so a signature gets more room than the sentence describing it. Nothing is centred except the 404's message block, which is short.

### Index (`/developers`)

```
+--------------------------------------------------------------------------+
| (disc) Seikou developers      [ Search exports            ]  Auto|L|D    |
+--------------------------------------------------------------------------+
|                                                                          |
|  Build on Seikou's Blu-ray code                       (h1, condensed)    |
|  Eight TypeScript packages that read a disc's files, demux its streams,  |
|  draw its subtitles and play it in a browser. Every function has an      |
|  example the tests run.                                                  |
|                                                                          |
|  +-- read-playlist.ts ------------------------------------------------+  |
|  | import { parseMpls } from '@seikou/bdmv';                          |  |
|  | const playlist = parseMpls(bytes);                                 |  |
|  | for (const item of playlist.playItems) ...                         |  |
|  +--------------------------------------------------------------------+  |
|                                                                          |
|  Put the player in a page          the integration guide, one line   >   |
|  ----------------------------------------------------------------------  |
|  Reading and playing discs                                               |
|  @seikou/bdmv      The Blu-ray disc format, read without a player.       |
|  @seikou/pg        Presentation Graphics, the Blu-ray bitmap subtitles.  |
|  @seikou/ass       An ASS/SSA subtitle renderer ported from libass.      |
|  @seikou/engine    The Blu-ray player engine for browsers.               |
|  @seikou/matroska  Matroska and WebM reading and writing.                |
|                                                                          |
|  Running a disc library                                                  |
|  @seikou/nas       The wire contract between server, player, Worker.     |
|  @seikou/titles    Naming a disc library.                                |
|  @seikou/fansubs   Finding and timing fansub subtitles for a disc.       |
+--------------------------------------------------------------------------+
| Source on GitHub                                                         |
+--------------------------------------------------------------------------+
```

The hero is code, the most characteristic thing in this subject: a short, real snippet from `@seikou/bdmv`'s example, in the same well as every example on the site. The packages are rows, not cards, grouped by what a reader is building (the two groups are information: the first five run in a page or a worker, the last three serve a library), each with its README's first sentence. The index has no navigation column.

### Package page (`/developers/<package>`)

```
+--------------------------------------------------------------------------+
| (disc) Seikou developers      [ Search exports            ]  Auto|L|D    |
+------------------+-------------------------------------------------------+
| Packages         |  @seikou/bdmv                          (h1)           |
|  bdmv  <current> |  The Blu-ray disc format, read without a player. ...  |
|  pg              |                                                       |
|  ass             |  ## Modules     (README overview: prose, tables, code) |
|  engine          |  | Module          | What it does |                   |
|  matroska        |  ## Usage                                              |
|  nas             |  [ code well ]                                         |
|  titles          |                                                       |
|  fansubs         |  ## Functions                                         |
|                  |  parseMpls     Parses the bytes of a .mpls playlist.   |
| Guide            |  parseClpi     Parses the bytes of a .clpi file.       |
|  Integrating     |  ## Classes                                           |
|                  |  M2tsReader    ...                                     |
|                  |  ## Interfaces  ## Types  ## Constants                 |
+------------------+-------------------------------------------------------+
```

The README comes first (concepts before API, spec §2), then the exports grouped by kind, each a row of name and first sentence. On a package or export page the current package in the left column opens its own list of exports, grouped by kind.

### Export page (`/developers/<package>/<export>`), and a class page

```
+------------------+-------------------------------------------------------+
| Packages         |  @seikou/engine / HttpTransport         (crumbs)      |
|  ...             |  HttpTransport                          (h1)          |
|  engine <cur>    |  A class in @seikou/engine.                            |
|   Classes        |                                                       |
|    HttpTransport |  Reads <base>files/<path>?t=<token> with a single ...   |
|    PlayerContr.. |                                                       |
|   Functions      |  Members  constructor  setToken  read   (anchor list) |
|    openDisc      |                                                       |
|    ...           |  ### read                                  (#read)    |
|                  |  +-- signature well ---------------------------------+ |
|                  |  | read(                                             | |
|                  |  |   path: string,                                   | |
|                  |  |   offset: number,                                 | |
|                  |  |   length: number,                                 | |
|                  |  |   signal?: AbortSignal,                           | |
|                  |  | ): Promise<Uint8Array>                            | |
|                  |  +---------------------------------------------------+ |
|                  |  The bytes of path from offset, at most length; ...    |
|                  |  Parameters                                           |
|                  |  path     string        The file's path on the disc.   |
|                  |  offset   number        Bytes from the start ...       |
|                  |  Returns  Promise<Uint8Array>  ...                    |
|                  |  Throws   RemoteDiscError  nas-lost after 30 s ...     |
|                  |  Example                                              |
|                  |  +-- packages/engine/examples/http-transport.ts ----+ |
|                  |  | ...                                              | |
|                  |  +--------------------------------------------------+ |
|                  |  Source: packages/engine/src/disc/http-transport.ts:58 |
+------------------+-------------------------------------------------------+
```

The order follows the reader's question: what is it called (h1), what is its exact shape (the signature, before any prose), what does it do, what goes in, what comes out, what goes wrong, how do I call it, where is it. An interface or type page has its fields in the same table as parameters, then **Used by**, the exports whose signatures take or return it. A class page puts its constructor and members one after another, each a section with its own anchor (`#read`), listed under the class's summary.

### Phone width (375 px)

```
+-----------------------------------+
| (disc) Seikou developers  A|L|D   |
| [ Search exports     ]  Packages  |
+-----------------------------------+
| @seikou/engine / HttpTransport    |
| HttpTransport              (h1)   |
| A class in @seikou/engine.        |
| +-------------------------------+ |
| | read(                         | |
| |   path: string,               | |
| |   signal?: AbortSignal,  -->  | |  long lines scroll in the well
| | ): Promise<Uint8Array>        | |
| +-------------------------------+ |
| Parameters                        |
| path                              |
|   string                          |
|   The file's path on the disc.    |
| ...                               |
+-----------------------------------+
| Packages  (the navigation column, |
|  after the content)               |
| Source on GitHub                  |
+-----------------------------------+
```

The search field takes a second row of the bar, beside a **Packages** link (the whole row on the index, which has no navigation column); the theme switch shows its icons. The navigation column moves after the content (it follows `main` in the document, so this needs no script), and **Packages** jumps to it. Parameter rows stack: name, then type, then the sentence. Code wells scroll sideways inside themselves; the page never does.

## 4. Principles

1. **The signature leads.** On an export page the first thing under the name is its exact signature, set larger than any other code. Prose explains it afterwards.
2. **Code sits lower than the page.** Signatures and examples are wells in the deeper navy (in light, the deeper paper), with a control-strength edge: the site's only containers.
3. **Tone, not hue, in code.** Identifiers in ice, keywords and punctuation in mist, comments in mist, strings in green, and laser only on a type name that is a link. The one accent therefore always means "you can go there".
4. **Structure is information.** Groups exist where the content groups (kind of export, what a package is for); no numbering, no eyebrow labels, no badges. A kind is said in a sentence ("A class in `@seikou/engine`").
5. **Readable without JavaScript.** Everything here is CSS over static HTML; search is the one thing that waits for a script, and the read head works through `:target`.
6. **Part of Seikou.** The player's tokens, face, condensed headings, theme switch and disc mark; the help pages' layout of a narrow navigation column beside a reading column.

## 5. The memorable element: the read head

A disc player reads with a laser that tracks across the disc; this site's one bold move borrows it. In a signature, every parameter name is a link to its row in the parameter table (`#param-<name>`, `#<member>-param-<name>` on a class page), and a member's name is a link to its section. When a reader follows one, the target row lights in `--selected` and a 2 px laser line sweeps along its top edge, left to right, once (420 ms, ease-out), as if the read head had moved to that track. It answers the reader's own action, it shows exactly which row they asked about, and it needs no script (`:target`). With `prefers-reduced-motion: reduce` the line is simply there, without the sweep. A class member reached by its anchor (`#read`) gets the same line under its heading.

Everything around it stays quiet: no hover effects on rows, no entrance motion, no decoration in the bar.

## 6. Review against the defaults

Worked through as "an API reference site for a TypeScript library" to see where the first plan landed on defaults, and what changed:

- **Kind badges.** The first plan had a coloured pill per kind (`FUNCTION`, `CLASS`) beside each name and in the lists, which is the stock generator look and an all-caps label. Revised: the kind is a plain sentence under the h1, and package pages group by kind under real headings, so no badge is needed.
- **Index as a card grid.** Eight identical rounded cards in a 2×4 grid with an icon each. Revised: two groups of rows (what a reader is building), name and first sentence, because the reader scans names, and cards would hide that the packages differ in kind.
- **Gradient hero.** A radial glow behind a big headline, as the player's home has. Revised: the hero is a real snippet in a code well; the glow stays the player's.
- **Rainbow syntax theme.** A stock theme of six hues. Revised: tone-based highlighting with laser only on links (principle 3), so colour in code carries navigation, not decoration.
- **Mono names everywhere.** The h1 set in the code face, as many references do. Revised: the export's name is a title in Instrument Sans, condensed, as the player sets a disc's title; code face is for code.
- **A right-hand "On this page" column.** Revised away: the pages are short, a class page carries its own member list under its summary, and a third column would squeeze signatures at 1280 px.
- **Copy buttons on every block.** A button needs a script, sits over the code's first line on a phone, and selection already copies. Left out; the template can add one later without changing the well.

After the first screenshots (1280 and 375 px, dark and light):

- **The accessory removed: the rule beside each error.** Throws first had a 2 px left rule per error, a callout look that competed with the read head's line and was a second kind of container. Now errors are rows ruled like the parameters', the error's name first in weight 600: one visual language for "a list of named things".
- **The bar at 375 px.** "Seikou developers" ran under the Packages link; the second row now holds the search field and Packages, the first only the name and the switch.
- **The parameter table's type column** took 30% of the width and left a gap; it now fits its type, and the sentence takes the rest.
- **The current page in the navigation** used `--deep`, which in light is white on near-white and vanished; it uses `--selected` in both themes.
- **Package names in the index rows** came out in ice through `a code { color: inherit }`; they are laser like every other link, as principle 3 says.
- **Middle-dot meta strings and arrows on links.** Not used: the meta line is a sentence, and the source line reads "Source: `<path>:<line>`".

## 7. The markup contract

The page templates (`vite/devsite/render.ts`) emit this structure; the mocks show each piece with real content. Classes not listed here are not styled.

Every page:

```html
<body class="dev">
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="dev-bar">
    <a class="dev-home" href="/developers"><img src="/favicon.svg" alt="" width="28" height="28"><span class="dev-home-name">Seikou</span><span class="dev-home-sub">developers</span></a>
    <form class="search" role="search" action="/developers" onsubmit="return false">
      <label class="visually-hidden" for="search-input">Search exports</label>
      <input class="search-input" id="search-input" type="search" placeholder="Search exports" autocomplete="off" aria-controls="search-results" aria-expanded="false">
      <ul class="search-results" id="search-results" role="listbox" hidden>
        <li class="search-result" role="option" aria-selected="true"><a href="/developers/bdmv/parseMpls"><span class="search-name">parseMpls</span><span class="search-pkg">@seikou/bdmv</span><span class="search-summary">Parses the bytes of a .mpls playlist.</span></a></li>
      </ul>
    </form>
    <a class="dev-bar-packages" href="#packages">Packages</a>   <!-- shown at phone width only; omitted on the index -->
    <fieldset class="theme-switch">…the player's ThemeSwitch markup: label.theme-option > input + span.theme-word + svg.theme-icon…</fieldset>
  </header>
  <div class="dev-layout">            <!-- the index uses <div class="dev-layout dev-layout-wide"> and no nav -->
    <main class="dev-main" id="main">…</main>
    <nav class="dev-nav" id="packages" aria-label="Packages">…</nav>
  </div>
  <footer class="dev-foot"><a href="https://github.com/brianhvo02/seikou">Source on GitHub</a></footer>
</body>
```

The search field is in the HTML; until the script runs it does nothing. Results: the script fills `.search-results`, removes `hidden`, sets `aria-expanded`, and marks the active row with `aria-selected="true"`; an empty search shows one `li.search-empty` ("No export matches"), styled.

Navigation column:

```html
<nav class="dev-nav" id="packages" aria-label="Packages">
  <h2 class="nav-heading">Packages</h2>
  <ul class="nav-list">
    <li><a href="/developers/bdmv" aria-current="page">bdmv</a>   <!-- aria-current="page" on a package page, "true" on its export pages; div.nav-exports only on an export page (a package page lists its exports in main) -->
      <div class="nav-exports">
        <h3 class="nav-kind">Functions</h3>
        <ul><li><a href="/developers/bdmv/parseMpls" aria-current="page"><code>parseMpls</code></a></li></ul>
      </div>
    </li>
    <li><a href="/developers/pg">pg</a></li>
  </ul>
  <h2 class="nav-heading">Guide</h2>
  <ul class="nav-list"><li><a href="/developers/integrating">Integrating the player</a></li></ul>
</nav>
```

Index main: `h1.index-title`, `p.lede`, `figure.example.hero-example` (the example block below), `a.guide-link` (with `span.guide-link-name` and `span.guide-link-text`), then per group `section.pkg-group` > `h2` + `ul.pkg-list` > `li` > `a.pkg-row` > `code.pkg-name` + `span.pkg-summary`.

Package main: `nav.crumbs`, `h1.page-title`, `div.prose` (the README as HTML), then `section.export-group` > `h2` + `ul.export-list` > `li` > `a.export-row` > `code.export-row-name` + `span.export-row-summary`.

Export main:

```html
<nav class="crumbs" aria-label="Breadcrumb"><a href="/developers/bdmv">@seikou/bdmv</a><span class="crumb-sep" aria-hidden="true">/</span><span aria-current="page">parseMpls</span></nav>
<h1 class="page-title">parseMpls</h1>
<p class="export-kind">A function in <a href="/developers/bdmv"><code>@seikou/bdmv</code></a>.</p>
<pre class="signature"><code>…</code></pre>     <!-- one per overload, one after another -->
<div class="prose">…the doc comment as HTML…</div>
<section class="api-section"><h2 id="parameters">Parameters</h2>
  <table class="params"><thead class="visually-hidden"><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>
    <tr id="param-bytes"><th scope="row"><code>bytes</code></th><td class="param-type"><code>Uint8Array</code></td><td class="param-doc">…</td></tr>
  </tbody></table></section>
<section class="api-section"><h2 id="returns">Returns</h2><p class="returns"><code class="returns-type"><a class="type-link" href="/developers/bdmv/Mpls">Mpls</a></code> …</p></section>
<section class="api-section"><h2 id="throws">Throws</h2><ul class="throws"><li><code><a class="type-link" href="…">ParseError</a></code> for a bad signature, …</li></ul></section>  <!-- the error's code first; a type that is not public is a plain <code> -->
<section class="api-section"><h2 id="example">Example</h2><figure class="example">…</figure></section>
<section class="api-section"><h2 id="used-by">Used by</h2><ul class="used-by"><li><a href="…"><code>parseMpls</code></a></li></ul></section>
<p class="source-link">Source: <a href="https://github.com/…/blob/main/packages/bdmv/src/mpls-parser.ts#L188"><code>packages/bdmv/src/mpls-parser.ts:188</code></a></p>
```

An optional parameter carries `class="optional"` on its `tr` (the name gets a `?` in the signature already; the row says "Optional." at the start of its sentence). An interface's fields use the same `table.params` under `h2#fields`, rows `id="field-<name>"`.

Signature text: the template breaks a signature longer than 72 characters into one parameter a line, indented two spaces, with a trailing comma, as Prettier would. Inside `pre.signature > code`: `span.sig-name` for the declared name, `a.sig-param` (`href="#param-<name>"`) for each parameter name, `a.type-link` for a type that is a public export, `span.tok-k` for keywords (`function`, `class`, `new`, `readonly`, `type`, `const`) and `span.tok-p` for punctuation the template chooses to mute (`:`, `?`, `=>`, `|`). A type that is not a public export stays plain text.

Example block:

```html
<figure class="example">
  <figcaption class="example-file"><a href="https://github.com/…/packages/bdmv/examples/parse-mpls.ts"><code>packages/bdmv/examples/parse-mpls.ts</code></a></figcaption>
  <pre class="code"><code>…</code></pre>
</figure>
```

Highlighting inside `pre.code > code` is optional: if the template tokenizes, it emits `span.tok-k` (keywords), `span.tok-s` (strings), `span.tok-c` (comments), `span.tok-n` (numbers) and `a.type-link`; without them the code is plain ice in the well and still reads. Prose code blocks from READMEs and the guide (`div.prose pre`) take the same well.

Class page: after the class's prose, `nav.member-index` (`h2#members` "Members", `ul` of `a` with `code`), then one `section.member` per member, `id` = the member's name (`constructor` for the constructor), holding `h3.member-name` > `a.member-anchor` (`href="#<name>"`, the name in `code`), `p.member-kind` ("Method", "Property", "Constructor"), the `pre.signature`, `div.prose`, and `h4`-headed `.api-section`s (parameter rows `id="<member>-param-<name>"`).

404 main: `div.not-found` > `h1.page-title` ("No page at this address"), `p` ("It may name an export that was renamed or is no longer public. Search for it, or start from the packages."), and `a.guide-link` to `/developers`.

Shared utilities: `.visually-hidden` (as the player's), `.skip-link`.

`vite/devsite/site-css.test.ts` keeps this contract: every class the mocks use is styled, no colour literal appears in `site.css`, every `var()` names a defined token, the field, switch and wells use `--control-rim`, and motion lives only under `prefers-reduced-motion: no-preference`. The mocks open from a static server at the repository root (they link `src/ui/tokens.css`, the Instrument Sans stylesheet in `node_modules` and `public/favicon.svg` by relative path); `?theme=light` or `?theme=dark` forces a theme.
