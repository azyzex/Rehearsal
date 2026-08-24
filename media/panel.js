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
  /** @type {any} */
  let diagram = null;
  /** @type {'list' | 'diagram'} */
  let view = 'list';

  const el = {
    file: /** @type {HTMLElement} */ (document.getElementById('file')),
    connection: /** @type {HTMLElement} */ (document.getElementById('connection')),
    cancel: /** @type {HTMLButtonElement} */ (document.getElementById('cancel')),
    summary: /** @type {HTMLElement} */ (document.getElementById('summary')),
    rows: /** @type {HTMLElement} */ (document.getElementById('rows')),
    diagram: /** @type {HTMLElement} */ (document.getElementById('diagram')),
    tabList: /** @type {HTMLButtonElement} */ (document.getElementById('tab-list')),
    tabDiagram: /** @type {HTMLButtonElement} */ (document.getElementById('tab-diagram')),
  };

  function setView(next) {
    view = next;
    el.tabList.classList.toggle('active', view === 'list');
    el.tabDiagram.classList.toggle('active', view === 'diagram');
    el.rows.hidden = view !== 'list';
    el.diagram.hidden = view !== 'diagram';
    if (view === 'diagram') {
      renderDiagram();
    }
  }

  el.tabList.addEventListener('click', () => setView('list'));
  el.tabDiagram.addEventListener('click', () => setView('diagram'));

  // The edges are positioned from the laid-out cards, so they have to be
  // redrawn whenever the panel is resized.
  let resizeTimer;
  window.addEventListener('resize', () => {
    if (view !== 'diagram') {
      return;
    }
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderDiagram, 80);
  });

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
        diagram = null;
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

      case 'diagram':
        diagram = message.diagram;
        if (view === 'diagram') {
          renderDiagram();
        }
        break;

      case 'done':
        running = false;
        el.cancel.hidden = true;
        showSummary(message.summary);
        render();
        if (view === 'diagram') {
          renderDiagram();
        }
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

    if (finding.plan) {
      row.appendChild(renderPlan(finding.plan));
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

  // ---- impact diagram ----------------------------------------------------

  /**
   * The tables this migration touches, drawn with what happens to them.
   *
   * A schema diagram shows the same picture whatever you are about to run.
   * This one only exists because of the statements in the open file: the
   * dropped column struck through with the rows it costs, the foreign key
   * that will fail drawn broken, the table that will be locked marked as
   * locked. Same visual language as an ERD, opposite content.
   */
  function renderDiagram() {
    el.diagram.replaceChildren();

    if (!diagram || diagram.tables.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = running
        ? 'Working out what this touches…'
        : 'No tables were identified in this file.';
      el.diagram.appendChild(empty);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'diagram-grid';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'diagram-edges');
    grid.appendChild(svg);

    const cards = new Map();
    for (const table of diagram.tables) {
      const card = renderTableCard(table);
      cards.set(table.name, card);
      grid.appendChild(card);
    }

    el.diagram.appendChild(grid);
    el.diagram.appendChild(renderLegend());

    // Edges are positioned from the laid-out cards, so this has to happen
    // after the grid is in the document.
    requestAnimationFrame(() => drawEdges(svg, grid, cards));
  }

  function renderTableCard(table) {
    const card = document.createElement('div');
    card.className = `table-card ${table.severity}${table.doomed ? ' doomed' : ''}`;
    card.dataset.table = table.name;

    const head = document.createElement('div');
    head.className = 'table-head';

    const name = document.createElement('span');
    name.className = 'table-name';
    name.textContent = table.name;
    head.appendChild(name);

    if (typeof table.rows === 'number') {
      const rows = document.createElement('span');
      rows.className = 'table-rows';
      rows.textContent = `${table.rows.toLocaleString()} rows`;
      head.appendChild(rows);
    }
    card.appendChild(head);

    for (const column of table.columns) {
      card.appendChild(renderColumn(column));
    }

    if (table.notes.length) {
      const notes = document.createElement('div');
      notes.className = 'table-notes';
      for (const note of table.notes) {
        const line = document.createElement('div');
        line.className = `table-note ${note.severity}`;
        line.textContent = note.text;
        line.addEventListener('click', () =>
          vscode.postMessage({ type: 'reveal', index: note.statementIndex }),
        );
        notes.appendChild(line);
      }
      card.appendChild(notes);
    }

    return card;
  }

  function renderColumn(column) {
    const row = document.createElement('div');
    const touched = Boolean(column.impact);
    row.className = [
      'column',
      touched ? 'touched' : '',
      column.impact ? `impact-${column.impact}` : '',
      column.severity ? `sev-${column.severity}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    row.dataset.column = column.name;

    if (column.isPrimaryKey) {
      const key = document.createElement('span');
      key.className = 'pk';
      key.textContent = '⚿';
      row.appendChild(key);
    }

    const name = document.createElement('span');
    name.className = 'column-name';
    name.textContent = column.name;
    row.appendChild(name);

    if (column.note) {
      const note = document.createElement('span');
      note.className = 'column-note';
      note.textContent = column.note;
      row.appendChild(note);
    } else if (column.type) {
      const type = document.createElement('span');
      type.className = 'column-type';
      type.textContent = shortType(column.type);
      row.appendChild(type);
    }

    if (touched && typeof column.statementIndex === 'number') {
      row.addEventListener('click', () =>
        vscode.postMessage({ type: 'reveal', index: column.statementIndex }),
      );
    }

    return row;
  }

  /**
   * Draws a relationship as a curve between the two column rows it actually
   * connects, rather than between table centres — an arrow that lands on
   * `org_id` and leaves from `id` says which columns are involved without a
   * label.
   */
  function drawEdges(svg, grid, cards) {
    const frame = grid.getBoundingClientRect();
    svg.setAttribute('width', String(frame.width));
    svg.setAttribute('height', String(frame.height));
    svg.replaceChildren();

    for (const edge of diagram.edges) {
      const fromCard = cards.get(edge.fromTable);
      const toCard = cards.get(edge.toTable);
      if (!fromCard || !toCard || fromCard === toCard) {
        continue;
      }

      const from = anchorFor(fromCard, edge.fromColumn, frame);
      const to = anchorFor(toCard, edge.toColumn, frame);
      if (!from || !to) {
        continue;
      }

      // Leave from whichever side faces the other card.
      const leftToRight = from.centre <= to.centre;
      const start = { x: leftToRight ? from.right : from.left, y: from.y };
      const end = { x: leftToRight ? to.left : to.right, y: to.y };
      const bend = Math.max(24, Math.abs(end.x - start.x) / 2);

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute(
        'd',
        `M ${start.x} ${start.y} C ${start.x + (leftToRight ? bend : -bend)} ${start.y}, ` +
          `${end.x - (leftToRight ? bend : -bend)} ${end.y}, ${end.x} ${end.y}`,
      );
      path.setAttribute('class', `edge-line ${edge.origin} ${edge.severity}`);
      svg.appendChild(path);

      // A relationship that cannot be created is crossed out where it would
      // have landed, and labelled with why.
      if (edge.origin === 'added' && (edge.severity === 'blocking' || edge.severity === 'destructive')) {
        const midX = (start.x + end.x) / 2;
        const midY = (start.y + end.y) / 2;

        const cross = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        cross.setAttribute('d', `M ${midX - 5} ${midY - 5} L ${midX + 5} ${midY + 5} M ${midX + 5} ${midY - 5} L ${midX - 5} ${midY + 5}`);
        cross.setAttribute('class', 'edge-break');
        svg.appendChild(cross);

        if (edge.note) {
          const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          label.setAttribute('x', String(midX));
          label.setAttribute('y', String(midY - 9));
          label.setAttribute('text-anchor', 'middle');
          label.setAttribute('class', 'edge-label');
          label.textContent = edge.note;
          svg.appendChild(label);
        }
      }
    }
  }

  /** Where on a card an edge for `column` should attach, relative to the grid. */
  function anchorFor(card, column, frame) {
    const target =
      card.querySelector(`.column[data-column="${cssEscape(column)}"]`) ??
      card.querySelector('.column');
    if (!target) {
      return null;
    }

    const box = target.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    return {
      left: cardBox.left - frame.left,
      right: cardBox.right - frame.left,
      centre: cardBox.left + cardBox.width / 2,
      y: box.top - frame.top + box.height / 2,
    };
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function renderLegend() {
    const legend = document.createElement('div');
    legend.className = 'diagram-legend';
    legend.textContent =
      'Only the tables this file touches. Struck-through columns are dropped, ' +
      'crossed arrows are relationships that cannot be created, and every number ' +
      'was measured against your data. Click anything to jump to the statement.';
    return legend;
  }

  function shortType(type) {
    return type
      .replace('character varying', 'varchar')
      .replace('timestamp with time zone', 'timestamptz')
      .replace('timestamp without time zone', 'timestamp')
      .replace('double precision', 'float8');
  }

  /**
   * The query plan, drawn to scale.
   *
   * Bar width comes from time actually spent in a node, not from the planner's
   * estimated cost. A plan drawn by cost shows you what the planner believed,
   * and the cases worth looking at are exactly the ones where it believed
   * wrong. Nesting is shown by indentation, so the tree reads top-down the way
   * the plan does.
   */
  function renderPlan(plan) {
    const wrap = document.createElement('div');
    wrap.className = 'plan';

    const head = document.createElement('div');
    head.className = 'plan-head';
    head.textContent = `Query plan — ${plan.totalMs.toFixed(1)} ms total`;
    wrap.appendChild(head);

    const total = plan.totalMs || 1;
    const walk = (node, depth) => {
      wrap.appendChild(renderPlanNode(node, depth, total));
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    };
    walk(plan.root, 0);

    for (const insight of plan.insights) {
      const line = document.createElement('div');
      line.className = 'plan-insight';
      line.textContent = insight.message;
      wrap.appendChild(line);
    }

    return wrap;
  }

  function renderPlanNode(node, depth, total) {
    const share = Math.max(0, Math.min(1, node.selfMs / total));

    const row = document.createElement('div');
    // Colour by how much of the total this node holds on its own, so the eye
    // lands on the hot node before reading a single name.
    row.className = `plan-node ${share > 0.4 ? 'hot' : share > 0.15 ? 'warm' : 'cool'}`;

    const label = document.createElement('span');
    label.className = 'plan-label';
    label.textContent =
      `${'  '.repeat(depth)}${node.kind}${node.relation ? ` on ${node.relation}` : ''}`;
    label.title = `${node.actualRows.toLocaleString()} rows, planner expected ${node.estimatedRows.toLocaleString()}`;
    row.appendChild(label);

    const bar = document.createElement('span');
    bar.className = 'plan-bar';
    const fill = document.createElement('span');
    fill.className = 'plan-fill';
    // Anything non-zero stays visible; a bar you cannot see reads as no bar.
    fill.style.width = `${Math.max(share * 100, 1)}%`;
    bar.appendChild(fill);
    row.appendChild(bar);

    const ms = document.createElement('span');
    ms.className = 'plan-ms';
    ms.textContent = `${node.selfMs.toFixed(1)} ms`;
    row.appendChild(ms);

    return row;
  }
})();
