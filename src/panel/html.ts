/**
 * The HTML each panel loads.
 *
 * Lifted out of the panels so it can be rendered somewhere other than an
 * editor. A webview's markup is the one part of it that nothing could test
 * before: it was built inside a class from `vscode` objects and handed
 * straight to the editor, so "the element exists" and "the script can find it"
 * were assumptions rather than facts.
 *
 * These take a `media` resolver and a nonce instead of a webview, which is the
 * whole trick — the editor passes `webview.asWebviewUri`, and the UI tests
 * pass a function returning a plain filename so a browser can load the same
 * markup from disk.
 */

export interface HtmlOptions {
  /** Resolves a file in `media/` to something the page can load. */
  readonly media: (file: string) => string;
  /** Goes in the CSP and on every script tag. */
  readonly nonce: string;
  /** The `style-src` the editor requires. Empty when rendering outside one. */
  readonly cspSource: string;
}

/** The nonce a webview's CSP needs. Regenerated for every panel. */
export function nonce(): string {
  return Array.from({ length: 32 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
      Math.floor(Math.random() * 62),
    ),
  ).join('');
}


/**
 * The Content-Security-Policy each panel runs under.
 *
 * `inlineStyles` exists for the schema explorer alone: it positions every card
 * by setting `style.left` and `style.top`, which is an inline style, and a
 * layout engine that cannot move anything is not a layout engine. Nothing else
 * gets it.
 */
function csp(options: HtmlOptions, inlineStyles = false): string {
  const styles = inlineStyles ? `${options.cspSource} 'unsafe-inline'` : options.cspSource;
  return `default-src 'none'; style-src ${styles}; script-src 'nonce-${options.nonce}';`;
}

/** The preview panel: a list of statements, and a diagram of what they touch. */
export function previewPanelHtml(options: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(options)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${options.media('panel.css')}" rel="stylesheet">
<title>Dry Run</title>
</head>
<body>
<header id="header">
  <div class="title">
    <span class="badge-dot" aria-hidden="true"></span>
    <span id="file">No file analysed yet</span>
  </div>
  <div class="meta">
    <div class="tabs" role="tablist">
      <button id="tab-list" class="tab active" type="button" role="tab">List</button>
      <button id="tab-diagram" class="tab" type="button" role="tab">Diagram</button>
    </div>
    <span id="connection"></span>
    <button id="cancel" type="button" hidden>Stop</button>
  </div>
</header>
<div id="summary" class="summary" hidden></div>
<main id="rows"></main>
<div id="diagram" hidden></div>
<footer id="footer">Nothing is committed. Dry Run only ever reads and rolls back.</footer>
<script nonce="${options.nonce}" src="${options.media('panel.js')}"></script>
</body>
</html>`;
}

/** The schema explorer: the whole database, and the pending edits to it. */
export function schemaPanelHtml(options: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(options, true)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${options.media('schema.css')}" rel="stylesheet">
<title>Database Schema</title>
</head>
<body>
<header id="toolbar">
  <div class="left">
    <span class="dot" aria-hidden="true"></span>
    <span id="stats">Reading the schema…</span>
    <span id="view-toggle" class="toggle" hidden>
      <button id="view-before" class="seg active" type="button">Now</button>
      <button id="view-after" class="seg" type="button">After changes</button>
    </span>
  </div>
  <div class="right">
    <input id="search" type="search" placeholder="Find a table or column" spellcheck="false">
    <select id="schema-filter" title="Schema"></select>
    <select id="focus" title="Show only tables near the selected one">
      <option value="0">Whole schema</option>
      <option value="1">1 hop</option>
      <option value="2">2 hops</option>
      <option value="3">3 hops</option>
    </select>
    <select id="overlay" title="Colour the tables by a measurement">
      <option value="none">No overlay</option>
      <option value="rows">Colour by rows</option>
      <option value="bytes">Colour by size</option>
      <option value="dead">Colour by dead rows</option>
      <option value="stale">Colour by stale statistics</option>
      <option value="fk">Foreign keys with no index</option>
    </select>
    <button id="fit" type="button" title="Fit the whole schema in view">Fit</button>
    <button id="relayout" type="button" title="Lay the diagram out again">Re-layout</button>
    <button id="new-table" type="button" title="Add a table to the pending changes">+ Table</button>
    <button id="export-diagram" type="button" title="Export as a Mermaid diagram GitHub can render">Export</button>
  </div>
</header>

<div id="body">
  <div id="stage">
    <div id="canvas">
      <svg id="edges" xmlns="http://www.w3.org/2000/svg"></svg>
      <div id="tables"></div>
    </div>
    <div id="status" class="status">Connecting…</div>
  </div>

  <aside id="drawer" hidden></aside>
</div>

<section id="changes" hidden>
  <header class="changes-head">
    <span id="changes-title">Pending changes</span>
    <span class="spacer"></span>
    <button id="export" type="button">Export SQL</button>
    <button id="export-down" type="button" title="The migration that undoes this one">Down SQL</button>
    <button id="export-plan" type="button" hidden
      title="The same change spread across deploys, so no step is ever incompatible with the code beside it">Safe steps</button>
    <button id="discard" type="button">Discard</button>
    <button id="show-affected" type="button" hidden
      title="Frame the tables this preview lands on">Show me where</button>
    <button id="preview" type="button" class="primary">Preview</button>
    <button id="apply" type="button" class="danger" hidden>Apply</button>
  </header>
  <div id="changes-body"></div>
</section>

<div id="crowded" class="crowded" hidden></div>
<div id="overlay-note" class="overlay-note" hidden></div>
<footer id="legend">
  <span><i class="swatch pk"></i> primary key</span>
  <span><i class="swatch fk"></i> foreign key</span>
  <span>Drag to move · scroll to zoom · click a table to open it</span>
  <span id="connection"></span>
</footer>

<script nonce="${options.nonce}" src="${options.media('schema.js')}"></script>
<script nonce="${options.nonce}" src="${options.media('schema-editor.js')}"></script>
</body>
</html>`;
}

/** The index panel: one card per candidate, with before and after on one scale. */
export function indexPanelHtml(options: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="${csp(options)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${options.media('panel.css')}" rel="stylesheet">
<title>Dry Run — Indexes</title>
</head>
<body>
<header id="header">
  <div class="title">
    <span class="badge-dot" aria-hidden="true"></span>
    <span id="query">No query tested yet</span>
  </div>
  <div class="meta">
    <span id="connection"></span>
  </div>
</header>
<div id="summary" class="summary" hidden></div>
<main id="results"></main>
<footer id="footer">No index was kept. Dry Run only ever reads and rolls back.</footer>
<script nonce="${options.nonce}" src="${options.media('indexes.js')}"></script>
</body>
</html>`;
}

/**
 * The view in the activity bar: connect, then launch everything else.
 *
 * Two states in one page rather than two pages, because the transition between
 * them is the whole point and a reload in the middle of it loses the string
 * someone has just pasted.
 */
export function sidebarHtml(options: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(options)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${options.media('sidebar.css')}" rel="stylesheet">
<title>Dry Run</title>
</head>
<body>
<div id="connect">
  <p class="lede">
    Point Dry Run at a database. It reads, measures, and rolls everything back.
  </p>

  <label class="field-label" for="connection">Connection string</label>
  <textarea id="connection" rows="3" spellcheck="false"
    placeholder="postgresql://user:password@host/database"></textarea>

  <div id="detected" class="detected" hidden></div>
  <div id="notes" class="notes"></div>

  <label class="remember">
    <input id="remember" type="checkbox" checked>
    <span>Remember this one</span>
  </label>

  <button id="go" class="primary" type="button">Connect</button>
  <div id="error" class="error" hidden></div>

  <div class="or">or</div>
  <button id="from-env" class="ghost" type="button">Use a .env file…</button>

  <section id="saved-section" hidden>
    <h2>Saved</h2>
    <div id="saved"></div>
  </section>
</div>

<div id="ready" hidden>
  <div class="connected">
    <div class="connected-head">
      <span class="dot"></span>
      <span id="connected-label"></span>
    </div>
    <div class="connected-meta">
      <span id="connected-engine" class="badge-engine"></span>
      <span id="connected-source"></span>
    </div>
    <div id="connected-note" class="connected-note" hidden></div>
  </div>

  <h2>Look at it</h2>
  <button class="action" type="button" data-command="dryrun.exploreSchema">
    <span class="action-name">Explore the schema</span>
    <span class="action-why">Every table and relationship, drawn</span>
  </button>
  <button class="action" type="button" data-command="dryrun.schemaHealth">
    <span class="action-name">Schema health</span>
    <span class="action-why">Unindexed keys, unread indexes, stale statistics</span>
  </button>
  <button class="action" type="button" data-command="dryrun.compareSchemas">
    <span class="action-name">Compare with another database</span>
    <span class="action-why">Drift between two environments</span>
  </button>

  <h2>Measure a change</h2>
  <button class="action" type="button" data-command="dryrun.preview">
    <span class="action-name">Preview the open file</span>
    <span class="action-why">What each statement would really do</span>
  </button>
  <button class="action" type="button" data-command="dryrun.pendingMigrations">
    <span class="action-name">Preview pending migrations</span>
    <span class="action-why">What your ORM has queued up</span>
  </button>
  <button class="action" type="button" data-command="dryrun.suggestIndexes">
    <span class="action-name">Would an index help?</span>
    <span class="action-why">Tested against the planner, not guessed</span>
  </button>

  <h2>Afterwards</h2>
  <button class="action" type="button" data-command="dryrun.appliedChanges">
    <span class="action-name">Applied changes</span>
    <span class="action-why">What ran, with its rescue file and down migration</span>
  </button>

  <button id="disconnect" class="ghost" type="button">Disconnect</button>
</div>

<div id="busy" hidden>
  <p class="lede">Connecting…</p>
</div>

<footer id="footer">Nothing is committed. Dry Run only ever reads and rolls back.</footer>
<script nonce="${options.nonce}" src="${options.media('sidebar.js')}"></script>
</body>
</html>`;
}
