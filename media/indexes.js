// @ts-check
/**
 * The index panel.
 *
 * One card per candidate. The bar is the point: a cost that drops by two
 * orders of magnitude and a cost that drops by four per cent are the same
 * sentence in English and obviously different pictures.
 */
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {any[]} */
  let results = [];

  const el = {
    query: /** @type {HTMLElement} */ (document.getElementById('query')),
    connection: /** @type {HTMLElement} */ (document.getElementById('connection')),
    summary: /** @type {HTMLElement} */ (document.getElementById('summary')),
    results: /** @type {HTMLElement} */ (document.getElementById('results')),
  };

  window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.type) {
      case 'begin':
        results = [];
        el.query.textContent = oneLine(message.query);
        el.connection.textContent = message.connection;
        el.summary.hidden = true;
        render();
        break;

      case 'candidates':
        results = message.results;
        render();
        break;

      case 'result':
        results[message.index] = message.result;
        render();
        break;

      case 'done':
        el.summary.hidden = false;
        el.summary.textContent = message.summary;
        render();
        break;

      case 'failed':
        el.results.replaceChildren(banner(message.message));
        break;
    }
  });

  function render() {
    if (results.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nothing to test yet.';
      el.results.replaceChildren(empty);
      return;
    }
    el.results.replaceChildren(...results.map(renderCard));
  }

  function renderCard(result) {
    const card = document.createElement('div');
    card.className = 'row ' + verdictClass(result);

    const head = document.createElement('div');
    head.className = 'row-head';

    const badge = document.createElement('span');
    badge.className = 'badge ' + verdictClass(result);
    badge.textContent = verdictText(result);
    head.appendChild(badge);

    const sql = document.createElement('code');
    sql.className = 'statement';
    sql.textContent = result.candidate.sql;
    head.appendChild(sql);
    card.appendChild(head);

    const why = document.createElement('div');
    why.className = 'detail';
    why.textContent = result.candidate.reason;
    card.appendChild(why);

    if (result.error) {
      const note = document.createElement('div');
      note.className = 'unavailable';
      note.textContent = result.error;
      card.appendChild(note);
      return card;
    }

    const experiment = result.experiment;
    if (!experiment) {
      const note = document.createElement('div');
      note.className = 'pending-note';
      note.textContent = 'Testing it against the planner…';
      card.appendChild(note);
      return card;
    }

    card.appendChild(comparison('Planner cost', experiment.beforeCost, experiment.afterCost, ''));
    if (typeof experiment.beforeMs === 'number' && typeof experiment.afterMs === 'number') {
      card.appendChild(comparison('Measured', experiment.beforeMs, experiment.afterMs, 'ms'));
    }

    if (experiment.note) {
      const note = document.createElement('div');
      note.className = 'sample-note';
      note.textContent = experiment.note;
      card.appendChild(note);
    }

    card.appendChild(actions(result.candidate));
    return card;
  }

  /**
   * Two bars on one scale.
   *
   * Drawn against the larger of the two so the shorter bar is the improvement,
   * read at a glance and without arithmetic.
   */
  function comparison(label, before, after, unit) {
    const box = document.createElement('div');
    box.className = 'compare';

    const title = document.createElement('div');
    title.className = 'compare-label';
    title.textContent = label;
    box.appendChild(title);

    const scale = Math.max(before, after, 1);
    for (const [name, value] of [
      ['Now', before],
      ['With the index', after],
    ]) {
      const line = document.createElement('div');
      line.className = 'compare-line';

      const caption = document.createElement('span');
      caption.className = 'compare-name';
      caption.textContent = name;
      line.appendChild(caption);

      const track = document.createElement('span');
      track.className = 'compare-track';
      const fill = document.createElement('span');
      fill.className = 'compare-fill' + (name === 'Now' ? ' before' : ' after');
      fill.style.width = Math.max(1, (value / scale) * 100) + '%';
      track.appendChild(fill);
      line.appendChild(track);

      const number = document.createElement('span');
      number.className = 'compare-value';
      number.textContent = format(value) + unit;
      line.appendChild(number);

      box.appendChild(line);
    }

    const change = document.createElement('div');
    change.className = 'compare-change';
    change.textContent = describeChange(before, after, unit);
    box.appendChild(change);

    return box;
  }

  function describeChange(before, after, unit) {
    if (after >= before) {
      return after === before ? 'No change.' : 'Worse, not better.';
    }
    const factor = before / Math.max(after, 0.0001);
    if (factor >= 2) {
      return format(factor) + '× cheaper.';
    }
    return Math.round((1 - after / before) * 100) + '% cheaper.';
  }

  function actions(candidate) {
    const box = document.createElement('div');
    box.className = 'rewrite-actions';

    const copy = document.createElement('button');
    copy.className = 'tiny';
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(candidate.sql + ';');
      copy.textContent = 'Copied';
      setTimeout(() => {
        copy.textContent = 'Copy';
      }, 1200);
    });
    box.appendChild(copy);

    // CONCURRENTLY is what you would really run on a live table, and it cannot
    // go in a transaction — so it is offered as text to copy, never as an
    // action this extension takes.
    const concurrent = document.createElement('button');
    concurrent.className = 'tiny';
    concurrent.type = 'button';
    concurrent.textContent = 'Copy as CONCURRENTLY';
    concurrent.addEventListener('click', () => {
      void navigator.clipboard?.writeText(
        candidate.sql.replace(/^CREATE INDEX/i, 'CREATE INDEX CONCURRENTLY') + ';',
      );
      concurrent.textContent = 'Copied';
      setTimeout(() => {
        concurrent.textContent = 'Copy as CONCURRENTLY';
      }, 1200);
    });
    box.appendChild(concurrent);

    const insert = document.createElement('button');
    insert.className = 'tiny';
    insert.type = 'button';
    insert.textContent = 'Add to file';
    insert.addEventListener('click', () => {
      vscode.postMessage({ type: 'insertIndex', sql: candidate.sql });
    });
    box.appendChild(insert);

    return box;
  }

  function verdictClass(result) {
    if (result.error) {
      return 'caution';
    }
    if (!result.experiment) {
      return 'pending';
    }
    if (!result.experiment.used) {
      return 'caution';
    }
    return result.experiment.afterCost < result.experiment.beforeCost ? 'safe' : 'caution';
  }

  function verdictText(result) {
    if (result.error) {
      return 'Could not test';
    }
    if (!result.experiment) {
      return 'Testing…';
    }
    if (!result.experiment.used) {
      return 'Planner ignores it';
    }
    return 'Used';
  }

  function format(value) {
    if (value >= 1000) {
      return Math.round(value).toLocaleString();
    }
    if (value >= 10) {
      return value.toFixed(0);
    }
    return value.toFixed(2);
  }

  function banner(text) {
    const div = document.createElement('div');
    div.className = 'banner';
    div.textContent = text;
    return div;
  }

  function oneLine(sql) {
    return sql.replace(/\s+/g, ' ').trim();
  }
})();
