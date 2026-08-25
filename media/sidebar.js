// @ts-check
/**
 * The view in the activity bar.
 *
 * Two states, one page. Not connected: a box to paste a connection string into,
 * with the engine worked out as you type. Connected: a launcher for everything
 * else, and a line saying what you are pointed at.
 *
 * Detection runs on every keystroke and never touches the network — it is a
 * string parse, and the whole point is that it can answer before you have
 * finished typing.
 */
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    connect: /** @type {HTMLElement} */ (document.getElementById('connect')),
    ready: /** @type {HTMLElement} */ (document.getElementById('ready')),
    busy: /** @type {HTMLElement} */ (document.getElementById('busy')),
    connection: /** @type {HTMLTextAreaElement} */ (document.getElementById('connection')),
    detected: /** @type {HTMLElement} */ (document.getElementById('detected')),
    notes: /** @type {HTMLElement} */ (document.getElementById('notes')),
    remember: /** @type {HTMLInputElement} */ (document.getElementById('remember')),
    go: /** @type {HTMLButtonElement} */ (document.getElementById('go')),
    error: /** @type {HTMLElement} */ (document.getElementById('error')),
    fromEnv: /** @type {HTMLButtonElement} */ (document.getElementById('from-env')),
    savedSection: /** @type {HTMLElement} */ (document.getElementById('saved-section')),
    saved: /** @type {HTMLElement} */ (document.getElementById('saved')),
    connectedLabel: /** @type {HTMLElement} */ (document.getElementById('connected-label')),
    connectedEngine: /** @type {HTMLElement} */ (document.getElementById('connected-engine')),
    connectedSource: /** @type {HTMLElement} */ (document.getElementById('connected-source')),
    connectedNote: /** @type {HTMLElement} */ (document.getElementById('connected-note')),
    disconnect: /** @type {HTMLButtonElement} */ (document.getElementById('disconnect')),
    footer: /** @type {HTMLElement} */ (document.getElementById('footer')),
  };

  window.addEventListener('message', (event) => {
    try {
      handle(event.data);
    } catch (error) {
      // Same guard as every other webview here. A thrown handler leaves a panel
      // that has stopped responding with nothing on screen to say why.
      console.error('Dry Run: ' + (error && error.message ? error.message : String(error)), error);
      show('connect');
      fail(error && error.message ? error.message : String(error));
    }
  });

  function handle(message) {
    switch (message.type) {
      case 'state':
        render(message);
        break;

      case 'detected':
        renderDetection(message.detection);
        break;

      case 'connecting':
        show('busy');
        break;

      case 'connected':
        el.error.hidden = true;
        el.connection.value = '';
        break;

      case 'failed':
        show('connect');
        fail(message.message);
        break;
    }
  }

  function show(which) {
    el.connect.hidden = which !== 'connect';
    el.ready.hidden = which !== 'ready';
    el.busy.hidden = which !== 'busy';
  }

  function fail(message) {
    el.error.hidden = false;
    el.error.textContent = message;
  }

  function render(state) {
    if (state.connected) {
      el.connectedLabel.textContent = state.connected.label;
      el.connectedEngine.textContent = state.connected.engineName;
      el.connectedEngine.dataset.engine = state.connected.engine;
      el.connectedSource.textContent = state.connected.source || '';

      // The one thing worth saying about the engine before someone acts: what
      // it cannot promise. Postgres can undo a schema change; the other two
      // cannot, and Apply behaves differently as a result.
      el.connectedNote.hidden = state.connected.transactionalDdl;
      if (!state.connected.transactionalDdl) {
        el.connectedNote.textContent =
          state.connected.engine === 'mongo'
            ? 'Index and collection changes cannot run in a transaction here, so they are ' +
              'measured by counting rather than by being run.'
            : 'MySQL commits schema changes the moment they run, so they are measured by ' +
              'counting rather than by being run — and a changeset containing one cannot ' +
              'be applied as a single unit.';
      }

      show('ready');
    } else {
      show('connect');
    }

    renderSaved(state.saved || []);
  }

  function renderSaved(saved) {
    el.savedSection.hidden = saved.length === 0;
    el.saved.replaceChildren();

    for (const entry of saved) {
      const row = document.createElement('div');
      row.className = 'saved-row';

      const open = document.createElement('button');
      open.className = 'saved-open';
      open.type = 'button';
      open.title = 'Connect to ' + entry.label;
      open.addEventListener('click', () =>
        vscode.postMessage({ type: 'connectSaved', id: entry.id }),
      );

      const badge = document.createElement('span');
      badge.className = 'badge-engine small';
      badge.dataset.engine = entry.engine;
      badge.textContent = shortEngine(entry.engine);
      open.appendChild(badge);

      const name = document.createElement('span');
      name.className = 'saved-name';
      name.textContent = entry.label;
      open.appendChild(name);

      row.appendChild(open);

      const forget = document.createElement('button');
      forget.className = 'saved-forget';
      forget.type = 'button';
      forget.title = 'Forget this connection';
      forget.textContent = '×';
      forget.addEventListener('click', () => vscode.postMessage({ type: 'forget', id: entry.id }));
      row.appendChild(forget);

      el.saved.appendChild(row);
    }
  }

  function renderDetection(detection) {
    const empty = el.connection.value.trim().length === 0;
    el.detected.hidden = empty;
    el.notes.replaceChildren();

    if (empty) {
      return;
    }

    if (detection.problem) {
      el.detected.className = 'detected bad';
      el.detected.textContent = detection.problem;
      el.go.disabled = true;
      return;
    }

    el.go.disabled = false;
    el.detected.className = 'detected good';
    el.detected.replaceChildren();

    const badge = document.createElement('span');
    badge.className = 'badge-engine';
    badge.dataset.engine = detection.engine;
    badge.textContent = engineName(detection.engine);
    el.detected.appendChild(badge);

    const where = document.createElement('span');
    where.className = 'detected-label';
    where.textContent = detection.label;
    el.detected.appendChild(where);

    if (detection.inferred) {
      const guessed = document.createElement('span');
      guessed.className = 'detected-guess';
      guessed.textContent = 'guessed from the port';
      el.detected.appendChild(guessed);
    }

    for (const note of detection.notes || []) {
      const line = document.createElement('div');
      line.className = 'note';
      line.textContent = note;
      el.notes.appendChild(line);
    }
  }

  function engineName(engine) {
    return engine === 'postgres' ? 'PostgreSQL' : engine === 'mysql' ? 'MySQL' : 'MongoDB';
  }

  function shortEngine(engine) {
    return engine === 'postgres' ? 'PG' : engine === 'mysql' ? 'SQL' : 'MDB';
  }

  // ---- wiring --------------------------------------------------------------

  el.connection.addEventListener('input', () => {
    el.error.hidden = true;
    vscode.postMessage({ type: 'detect', value: el.connection.value });
  });

  el.connection.addEventListener('keydown', (event) => {
    // Enter connects; shift+enter is a newline, because a connection string
    // pasted from a dashboard sometimes arrives wrapped.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      el.go.click();
    }
  });

  el.go.addEventListener('click', () => {
    vscode.postMessage({
      type: 'connect',
      value: el.connection.value,
      remember: el.remember.checked,
    });
  });

  el.fromEnv.addEventListener('click', () => vscode.postMessage({ type: 'pickEnvFile' }));
  el.disconnect.addEventListener('click', () => vscode.postMessage({ type: 'disconnect' }));

  for (const button of document.querySelectorAll('.action')) {
    button.addEventListener('click', () =>
      vscode.postMessage({ type: 'run', command: button.dataset.command }),
    );
  }

  vscode.postMessage({ type: 'ready' });
})();
