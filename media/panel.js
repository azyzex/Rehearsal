// @ts-check
/**
 * The panel's view layer.
 *
 * Deliberately plain: no framework, no build step for this file. The state is
 * a list of statements and a map of findings, and rendering is one function.
 * Bundle size matters here because the webview is created on demand and the
 * user is waiting for it.
 *
 * All wording arrives pre-written from the extension. This file does no
 * arithmetic and makes no judgements about severity — it draws what it is told.
 */

(function () {
  const vscode = acquireVsCodeApi();

  /** @type {{ index: number, sql: string, startLine: number, endLine: number }[]} */
  let statements = [];
  /** @type {Map<number, any>} */
  let findings = new Map();
  /** @type {Set<number>} */
  const expanded = new Set();
  /** @type {number | null} */
  let current = null;
  let running = false;

  const el = {
    file: /** @type {HTMLElement} */ (document.getElementById('file')),
    connection: /** @type {HTMLElement} */ (document.getElementById('connection')),
    cancel: /** @type {HTMLButtonElement} */ (document.getElementById('cancel')),
    summary: /** @type {HTMLElement} */ (document.getElementById('summary')),
    rows: /** @type {HTMLElement} */ (document.getElementById('rows')),
  };

  el.cancel.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
    el.cancel.disabled = true;
    el.cancel.textContent = 'Stopping…';
  });

  window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.type) {
      case 'begin':
        statements = message.statements;
        findings = new Map();
        expanded.clear();
        current = null;
        running = true;
        el.file.textContent = message.file;
        el.connection.textContent = message.connection;
        el.cancel.hidden = false;
        el.cancel.disabled = false;
        el.cancel.textContent = 'Stop';
        el.summary.hidden = true;
        render();
        break;

      case 'finding':
        findings.set(message.finding.statementIndex, message.finding);
        render();
        break;

      case 'done':
        running = false;
        el.cancel.hidden = true;
        showSummary(message.summary);
        render();
        break;

      case 'failed':
        running = false;
        el.cancel.hidden = true;
        el.rows.innerHTML = '';
        el.rows.appendChild(banner(message.message));
        break;

      case 'highlight':
        current = message.index;
        render();
        break;
    }
  });

  function showSummary(text) {
    if (!text) {
      el.summary.hidden = true;
      return;
    }
    el.summary.textContent = text;
    el.summary.hidden = false;
  }

  function banner(text) {
    const div = document.createElement('div');
    div.className = 'banner';
    div.textContent = text;
    return div;
  }

  function render() {
    if (statements.length === 0) {
      el.rows.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No statements found in this file.';
      el.rows.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const statement of statements) {
      fragment.appendChild(renderRow(statement, findings.get(statement.index)));
    }
    el.rows.replaceChildren(fragment);
  }

  function renderRow(statement, finding) {
    const severity = finding ? finding.severity : 'pending';

    const row = document.createElement('div');
    row.className = `row ${severity}${current === statement.index ? ' current' : ''}`;
    row.addEventListener('click', () => {
      vscode.postMessage({ type: 'reveal', index: statement.index });
    });

    const head = document.createElement('div');
    head.className = 'row-head';

    const badge = document.createElement('span');
    badge.className = `badge ${severity}`;
    badge.textContent = finding ? finding.headline : running ? 'Checking…' : 'Not run';
    head.appendChild(badge);

    const sql = document.createElement('code');
    sql.className = 'statement';
    sql.textContent = oneLine(statement.sql);
    head.appendChild(sql);

    const line = document.createElement('span');
    line.className = 'line-number';
    line.textContent = `:${statement.startLine + 1}`;
    head.appendChild(line);

    row.appendChild(head);

    if (!finding) {
      const note = document.createElement('div');
      note.className = 'pending-note';
      note.textContent = running ? 'Measuring against your data…' : 'Not analysed.';
      row.appendChild(note);
      return row;
    }

    const detail = document.createElement('div');
    detail.className = `detail${finding.estimated ? ' estimated' : ''}`;
    detail.textContent = finding.detail;
    row.appendChild(detail);

    const bar = renderBlastRadius(finding);
    if (bar) {
      row.appendChild(bar);
    }

    const sample = finding.sample;
    if (sample && sample.unavailable) {
      const note = document.createElement('div');
      note.className = 'unavailable';
      note.textContent = sample.unavailable;
      row.appendChild(note);
    } else if (sample && sample.rows.length > 0) {
      row.appendChild(renderSampleToggle(statement.index, sample));
    }

    return row;
  }

  /**
   * How much of the table this touches, drawn to scale.
   *
   * A bare "40,072 rows" carries no weight until you know the table holds
   * 50,000. The bar answers that in the time it takes to glance at it, which
   * is the whole point of putting this in a panel rather than a log line.
   *
   * The table total is the planner's estimate, so the bar is proportional
   * rather than precise — the exact number stays in the sentence above, and
   * the bar carries no digits of its own.
   */
  function renderBlastRadius(finding) {
    const affected = finding.rowCount;
    const total = finding.tableRows;

    if (typeof affected !== 'number' || typeof total !== 'number' || total <= 0) {
      return null;
    }
    if (affected === 0) {
      return null; // nothing to draw, and the sentence already says so
    }

    const share = Math.max(0, Math.min(1, affected / total));

    const wrapper = document.createElement('div');
    wrapper.className = 'radius';

    const track = document.createElement('div');
    track.className = `radius-track ${finding.severity}`;

    const fill = document.createElement('div');
    fill.className = 'radius-fill';
    // Anything non-zero stays visible: a 12-in-50,000 row is 0.02% wide, and a
    // bar you cannot see reads as no bar at all.
    fill.style.width = `${Math.max(share * 100, 0.8)}%`;
    track.appendChild(fill);

    const label = document.createElement('span');
    label.className = 'radius-label';
    label.textContent =
      share >= 0.995 && affected < total
        ? `nearly all of ~${total.toLocaleString()} rows`
        : share === 1
          ? `every one of ~${total.toLocaleString()} rows`
          : `${formatShare(share)} of ~${total.toLocaleString()} rows`;

    wrapper.appendChild(track);
    wrapper.appendChild(label);
    return wrapper;
  }

  function formatShare(share) {
    const percent = share * 100;
    if (percent < 0.1) {
      return '<0.1%';
    }
    return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
  }

  function renderSampleToggle(index, sample) {
    const wrapper = document.createElement('div');
    const isOpen = expanded.has(index);

    const toggle = document.createElement('button');
    toggle.className = 'expand';
    toggle.type = 'button';
    toggle.textContent = isOpen ? 'Hide affected rows' : `Show ${sample.rows.length} affected rows`;
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      if (isOpen) {
        expanded.delete(index);
      } else {
        expanded.add(index);
      }
      render();
    });
    wrapper.appendChild(toggle);

    if (isOpen) {
      wrapper.appendChild(renderSample(sample));
    }
    return wrapper;
  }

  function renderSample(sample) {
    const container = document.createElement('div');
    container.className = 'sample';

    const first = sample.rows[0];
    const source = first.before || first.after || {};
    const columns = Object.keys(source);
    const keyColumns = Object.keys(first.key);

    const table = document.createElement('table');

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.appendChild(th(''));
    for (const column of columns) {
      headRow.appendChild(th(column));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of sample.rows) {
      // A deleted row has no after-state and an inserted row has no before, so
      // only the half that exists is drawn.
      if (row.before) {
        tbody.appendChild(sampleRow('before', row, columns, keyColumns, false));
      }
      if (row.after) {
        // An UPDATE can rewrite a row without altering it. Labelling that is
        // the difference between an honest report and a rendering bug.
        const label = !row.before ? 'new' : row.changed.length === 0 ? 'unchanged' : 'after';
        tbody.appendChild(sampleRow(label, row, columns, keyColumns, true));
      }
    }
    table.appendChild(tbody);
    container.appendChild(table);

    if (sample.totalAffected > sample.rows.length) {
      const note = document.createElement('div');
      note.className = 'sample-note';
      note.textContent = `Showing ${sample.rows.length} of ${sample.totalAffected.toLocaleString()} affected rows.`;
      container.appendChild(note);
    }

    return container;
  }

  function sampleRow(label, row, columns, keyColumns, isAfter) {
    const tr = document.createElement('tr');
    tr.appendChild(td(label, 'key'));

    const values = isAfter ? row.after : row.before;
    for (const column of columns) {
      const changed = row.changed.indexOf(column) !== -1;
      const classes = [];
      if (changed) {
        classes.push('changed');
      }
      if (changed && isAfter) {
        classes.push('after');
      }
      if (keyColumns.indexOf(column) !== -1 && !changed) {
        classes.push('key');
      }
      tr.appendChild(td(values ? values[column] : '∅', classes.join(' ')));
    }
    return tr;
  }

  function th(text) {
    const cell = document.createElement('th');
    cell.textContent = text;
    return cell;
  }

  function td(text, className) {
    const cell = document.createElement('td');
    cell.textContent = text;
    if (className) {
      cell.className = className;
    }
    return cell;
  }

  function oneLine(sql) {
    return sql.replace(/\s+/g, ' ').trim();
  }
})();
