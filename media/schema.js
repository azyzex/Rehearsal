// @ts-check
/**
 * The schema explorer.
 *
 * Draws every table in the database as a card and every foreign key as a curve
 * between the two columns it actually connects. Pan, zoom, search, and click a
 * table to isolate it and its relationships.
 *
 * The layout is force-directed: related tables pull together, unrelated ones
 * push apart, and the result is that the shape of the schema — which cluster of
 * tables is the core of the application, which ones sit off on their own — is
 * visible before you have read a single name. A grid would be tidier and would
 * tell you nothing.
 */

(function () {
  const vscode = acquireVsCodeApi();

  /** @type {any} */
  let snapshot = null;
  /**
   * The schema as the database actually has it, kept aside so the before/after
   * switch has something to return to. `snapshot` is whichever of the two is
   * currently being drawn.
   */
  /** @type {any} */
  let baselineSnapshot = null;
  /** @type {Map<string, any>} */
  let nodes = new Map();
  /** @type {any[]} */
  let edges = [];
  /** @type {string | null} */
  let selected = null;
  let query = '';
  let schemaFilter = '';
  /** 0 shows the whole schema; higher shows only what is within N relationships. */
  let focusDepth = 0;
  /** Called when a card is clicked rather than dragged. Set through the bridge. */
  let onActivate = () => {};

  const view = { x: 0, y: 0, scale: 1 };

  const el = {
    stage: /** @type {HTMLElement} */ (document.getElementById('stage')),
    canvas: /** @type {HTMLElement} */ (document.getElementById('canvas')),
    tables: /** @type {HTMLElement} */ (document.getElementById('tables')),
    edges: /** @type {SVGSVGElement} */ (/** @type {any} */ (document.getElementById('edges'))),
    stats: /** @type {HTMLElement} */ (document.getElementById('stats')),
    status: /** @type {HTMLElement} */ (document.getElementById('status')),
    search: /** @type {HTMLInputElement} */ (document.getElementById('search')),
    schemaFilter: /** @type {HTMLSelectElement} */ (document.getElementById('schema-filter')),
    fit: /** @type {HTMLButtonElement} */ (document.getElementById('fit')),
    relayout: /** @type {HTMLButtonElement} */ (document.getElementById('relayout')),
    focus: /** @type {HTMLSelectElement} */ (document.getElementById('focus')),
    exportDiagram: /** @type {HTMLButtonElement} */ (document.getElementById('export-diagram')),
    newTable: /** @type {HTMLButtonElement} */ (document.getElementById('new-table')),
    connection: /** @type {HTMLElement} */ (document.getElementById('connection')),
    overlay: /** @type {HTMLSelectElement} */ (document.getElementById('overlay')),
    overlayNote: /** @type {HTMLElement} */ (document.getElementById('overlay-note')),
  };

  // How many columns to draw before collapsing the rest into a "+N more" line.
  // A card listing sixty columns is a wall, and at that point the useful
  // information is the table's name and its relationships, not every field.
  const MAX_COLUMNS = 12;
  const CARD_WIDTH = 210;
  const HEAD_HEIGHT = 30;
  const ROW_HEIGHT = 19;

  // ---- messages ----------------------------------------------------------

  window.addEventListener('message', (event) => {
    const message = event.data;

    if (message.type === 'loading') {
      el.status.hidden = false;
      el.status.textContent = 'Reading the schema…';
      el.connection.textContent = message.connection || '';
      return;
    }

    if (message.type === 'failed') {
      el.status.hidden = false;
      el.status.textContent = message.message;
      el.stats.textContent = 'Could not read the schema';
      return;
    }

    if (message.type === 'schema') {
      snapshot = message.snapshot;
      baselineSnapshot = message.snapshot;
      el.connection.textContent = message.connection || '';
      populateSchemaFilter();
      build();
      return;
    }

    if (message.type === 'health') {
      health = message.health;
      applyOverlay();
      return;
    }

    if (message.type === 'healthFailed') {
      el.overlayNote.hidden = false;
      el.overlayNote.textContent = `Could not read the statistics: ${message.message}`;
    }
  });

  // ---- building ----------------------------------------------------------

  function visibleTables() {
    if (!snapshot) {
      return [];
    }

    const inSchema = snapshot.tables.filter((t) => !schemaFilter || t.schema === schemaFilter);

    // Focus mode. Past about thirty tables the whole schema is a wall, and the
    // question is almost never "show me everything" — it is "show me this table
    // and what it touches". Unrelated tables are removed rather than dimmed, so
    // the layout re-runs around the neighbourhood and actually uses the space.
    if (focusDepth > 0 && selected) {
      const near = neighbourhood(selected, focusDepth);
      const focused = inSchema.filter((t) => near.has(t.qualified));
      if (focused.length > 0) {
        return focused;
      }
    }

    return inSchema;
  }

  /** Tables reachable from `root` in at most `depth` relationships, either way. */
  function neighbourhood(root, depth) {
    const reached = new Set([root]);
    let frontier = [root];

    for (let step = 0; step < depth; step++) {
      const next = [];
      for (const table of frontier) {
        for (const fk of snapshot.foreignKeys) {
          const other =
            fk.fromTable === table ? fk.toTable : fk.toTable === table ? fk.fromTable : null;
          if (other && !reached.has(other)) {
            reached.add(other);
            next.push(other);
          }
        }
      }
      if (next.length === 0) {
        break;
      }
      frontier = next;
    }

    return reached;
  }

  function build() {
    const tables = visibleTables();

    if (tables.length === 0) {
      el.status.hidden = false;
      el.status.textContent = snapshot
        ? 'No tables in this schema.'
        : 'Nothing to show yet.';
      el.tables.replaceChildren();
      el.edges.replaceChildren();
      el.stats.textContent = '0 tables';
      return;
    }

    const names = new Set(tables.map((t) => t.qualified));
    const keys = snapshot.foreignKeys.filter(
      (fk) => names.has(fk.fromTable) && names.has(fk.toTable),
    );

    nodes = new Map(
      tables.map((table) => {
        const shown = Math.min(table.columns.length, MAX_COLUMNS);
        const extra = table.columns.length > MAX_COLUMNS ? 1 : 0;
        return [
          table.qualified,
          {
            table,
            width: CARD_WIDTH,
            height: HEAD_HEIGHT + shown * ROW_HEIGHT + extra * 18 + 6,
            x: 0,
            y: 0,
          },
        ];
      }),
    );

    edges = keys.map((fk) => ({
      key: fk,
      from: fk.fromTable,
      to: fk.toTable,
      fromColumn: fk.fromColumns[0] || '',
      toColumn: fk.toColumns[0] || '',
    }));

    // A layout you arranged by hand beats one a simulation guessed at.
    if (!restorePositions()) {
      layout();
    }
    renderCards();
    renderEdges();
    fit();

    el.status.hidden = true;
    el.stats.textContent =
      `${tables.length} ${tables.length === 1 ? 'table' : 'tables'}, ` +
      `${keys.length} ${keys.length === 1 ? 'relationship' : 'relationships'}`;
  }

  /**
   * Force-directed layout.
   *
   * Related tables attract along their foreign keys, every pair repels, and a
   * weak pull toward the centre stops disconnected tables drifting away
   * forever. Deterministic: the same schema lays out the same way every time,
   * because a diagram that rearranges itself on every open is one you can never
   * learn the shape of.
   */
  function layout() {
    const list = [...nodes.values()];
    const count = list.length;
    if (count === 0) {
      return;
    }

    // Seeded placement on a spiral rather than at random, for that determinism.
    list.forEach((node, i) => {
      const angle = i * 2.399963; // golden angle, spreads without clustering
      const radius = 90 * Math.sqrt(i + 1);
      node.x = Math.cos(angle) * radius;
      node.y = Math.sin(angle) * radius;
      node.vx = 0;
      node.vy = 0;
    });

    if (count === 1) {
      list[0].x = 0;
      list[0].y = 0;
      return;
    }

    const iterations = count > 60 ? 220 : 400;
    const ideal = 260;

    for (let step = 0; step < iterations; step++) {
      const cooling = 1 - step / iterations;

      // Repulsion, every pair.
      for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
          const a = list[i];
          const b = list[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distance = Math.hypot(dx, dy) || 0.01;

          // Push apart harder while the boxes actually overlap, so cards do not
          // settle on top of one another.
          const overlapping =
            Math.abs(dx) < (a.width + b.width) / 2 && Math.abs(dy) < (a.height + b.height) / 2;
          const force = ((ideal * ideal) / distance) * (overlapping ? 2.4 : 1);

          dx /= distance;
          dy /= distance;
          a.vx -= dx * force * 0.0016;
          a.vy -= dy * force * 0.0016;
          b.vx += dx * force * 0.0016;
          b.vy += dy * force * 0.0016;
        }
      }

      // Attraction along relationships.
      for (const edge of edges) {
        const a = nodes.get(edge.from);
        const b = nodes.get(edge.to);
        if (!a || !b || a === b) {
          continue;
        }
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 0.01;
        const force = (distance - ideal) * 0.012;
        const ux = dx / distance;
        const uy = dy / distance;
        a.vx += ux * force;
        a.vy += uy * force;
        b.vx -= ux * force;
        b.vy -= uy * force;
      }

      for (const node of list) {
        // A weak pull home, so islands stay in frame.
        node.vx -= node.x * 0.0012;
        node.vy -= node.y * 0.0012;

        node.x += node.vx * cooling;
        node.y += node.vy * cooling;
        node.vx *= 0.86;
        node.vy *= 0.86;
      }
    }

    separate(list);
  }

  /** Final pass: nudge apart any cards still overlapping after the simulation. */
  function separate(list) {
    const padding = 26;
    for (let pass = 0; pass < 60; pass++) {
      let moved = false;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          const overlapX = (a.width + b.width) / 2 + padding - Math.abs(b.x - a.x);
          const overlapY = (a.height + b.height) / 2 + padding - Math.abs(b.y - a.y);

          if (overlapX > 0 && overlapY > 0) {
            moved = true;
            // Separate along whichever axis needs the smaller nudge.
            if (overlapX < overlapY) {
              const shift = (overlapX / 2) * (b.x >= a.x ? 1 : -1);
              a.x -= shift;
              b.x += shift;
            } else {
              const shift = (overlapY / 2) * (b.y >= a.y ? 1 : -1);
              a.y -= shift;
              b.y += shift;
            }
          }
        }
      }
      if (!moved) {
        break;
      }
    }
  }

  // ---- rendering ---------------------------------------------------------

  function renderCards() {
    const fragment = document.createDocumentFragment();

    for (const node of nodes.values()) {
      const card = document.createElement('div');
      card.className = 'table';
      card.dataset.table = node.table.qualified;
      card.style.left = `${node.x}px`;
      card.style.top = `${node.y}px`;
      card.style.width = `${node.width}px`;

      const head = document.createElement('div');
      head.className = 'table-head';

      const title = document.createElement('span');
      title.className = 'table-title';
      title.textContent = node.table.qualified;
      head.appendChild(title);

      const meta = document.createElement('span');
      meta.className = 'table-meta';
      meta.textContent = `${abbreviate(node.table.rows)} · ${bytes(node.table.bytes)}`;
      head.appendChild(meta);
      card.appendChild(head);

      const fkColumns = foreignKeyColumns(node.table.qualified);
      const shown = node.table.columns.slice(0, MAX_COLUMNS);

      for (const column of shown) {
        card.appendChild(renderColumn(column, fkColumns));
      }

      if (node.table.columns.length > MAX_COLUMNS) {
        const more = document.createElement('div');
        more.className = 'col-more';
        more.textContent = `+${node.table.columns.length - MAX_COLUMNS} more columns`;
        card.appendChild(more);
      }

      node.el = card;
      attachDrag(card, node);
      fragment.appendChild(card);
    }

    el.tables.replaceChildren(fragment);

    // Cards are rebuilt from scratch on every layout, so the overlay has to be
    // put back or it silently disappears the first time anything re-renders.
    applyOverlay();
  }

  function renderColumn(column, fkColumns) {
    const row = document.createElement('div');
    row.className = 'col';
    row.dataset.column = column.name;

    const key = document.createElement('span');
    key.className = `col-key ${column.isPrimaryKey ? 'pk' : fkColumns.has(column.name) ? 'fk' : ''}`;
    key.textContent = column.isPrimaryKey ? '⚿' : fkColumns.has(column.name) ? '↗' : '';
    row.appendChild(key);

    const name = document.createElement('span');
    name.className = `col-name${column.nullable ? ' nullable' : ''}`;
    name.textContent = column.name;
    row.appendChild(name);

    const type = document.createElement('span');
    type.className = 'col-type';
    type.textContent = shortType(column.type);
    row.appendChild(type);

    return row;
  }

  /**
   * Dragging a table.
   *
   * The automatic layout is a starting point, not an answer — it does not know
   * that these four tables are the ones you care about today. So the cards move,
   * and where you put them is remembered, because an arrangement you have to
   * rebuild every time you open the panel is one you stop bothering with.
   *
   * A press that does not move is a click, which selects. The threshold matters:
   * without it, every attempt to select would nudge the card a pixel and every
   * attempt to drag would also toggle the selection.
   */
  function attachDrag(card, node) {
    /** @type {any} */
    let drag = null;

    card.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      // Otherwise the stage starts panning underneath the card.
      event.stopPropagation();

      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: node.x,
        originY: node.y,
        moved: false,
      };
      card.setPointerCapture(event.pointerId);
      card.classList.add('dragging');
    });

    card.addEventListener('pointermove', (event) => {
      if (!drag) {
        return;
      }

      const screenDx = event.clientX - drag.startX;
      const screenDy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(screenDx, screenDy) > 3) {
        drag.moved = true;
      }
      if (!drag.moved) {
        return;
      }

      // Divided by the zoom, so the card tracks the cursor at any scale.
      node.x = drag.originX + screenDx / view.scale;
      node.y = drag.originY + screenDy / view.scale;
      card.style.left = `${node.x}px`;
      card.style.top = `${node.y}px`;
      renderEdges();
    });

    const finish = (event) => {
      if (!drag) {
        return;
      }
      card.classList.remove('dragging');
      if (card.hasPointerCapture(event.pointerId)) {
        card.releasePointerCapture(event.pointerId);
      }

      if (drag.moved) {
        savePositions();
      } else {
        selected = selected === node.table.qualified ? null : node.table.qualified;
        // With focus on, selecting changes which tables exist at all, not just
        // which are dimmed.
        if (focusDepth > 0) {
          build();
        }
        applyHighlight();

        // Opening the table is announced here rather than left to a click
        // listener further up the tree: the card stops the click from
        // propagating (so it does not also clear the selection), which means
        // nothing above this ever sees it.
        if (selected) {
          onActivate(node.table.qualified);
        }
      }
      drag = null;
    };

    card.addEventListener('pointerup', finish);
    card.addEventListener('pointercancel', finish);
    // The stage's click handler clears the selection; a click that landed on a
    // card has already been dealt with here.
    card.addEventListener('click', (event) => event.stopPropagation());
  }

  /**
   * Remembers where the tables were put, per database and schema.
   *
   * Webview state rather than anything on disk: it survives the panel being
   * hidden and restored, which is the case that matters, and it costs nothing
   * if it is lost.
   */
  function savePositions() {
    const positions = {};
    for (const [name, node] of nodes) {
      positions[name] = { x: Math.round(node.x), y: Math.round(node.y) };
    }
    vscode.setState({ key: layoutKey(), positions });
  }

  function restorePositions() {
    const state = vscode.getState();
    if (!state || state.key !== layoutKey() || !state.positions) {
      return false;
    }

    // Only reuse a saved layout that still covers every table. A schema that
    // has gained a table since would otherwise stack the new one at the origin.
    for (const name of nodes.keys()) {
      if (!state.positions[name]) {
        return false;
      }
    }

    for (const [name, node] of nodes) {
      node.x = state.positions[name].x;
      node.y = state.positions[name].y;
    }
    return true;
  }

  function layoutKey() {
    return `${el.connection.textContent || ''}::${schemaFilter}::${nodes.size}`;
  }

  function foreignKeyColumns(table) {
    const columns = new Set();
    for (const edge of edges) {
      if (edge.from === table) {
        for (const column of edge.key.fromColumns) {
          columns.add(column);
        }
      }
    }
    return columns;
  }

  /**
   * Relationships as curves between the two column rows they connect, leaving
   * from whichever side of the card faces the other one. An arrow that lands on
   * a specific row says which columns are involved without a label.
   */
  function renderEdges() {
    const bounds = contentBounds();
    el.edges.setAttribute('width', String(bounds.width));
    el.edges.setAttribute('height', String(bounds.height));
    el.edges.replaceChildren();

    for (const edge of edges) {
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      if (!from || !to || from === to) {
        continue;
      }

      const start = anchor(from, edge.fromColumn, to);
      const end = anchor(to, edge.toColumn, from);
      const bend = Math.max(30, Math.abs(end.x - start.x) * 0.4);
      const startBend = start.side === 'right' ? bend : -bend;
      const endBend = end.side === 'right' ? bend : -bend;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute(
        'd',
        `M ${start.x} ${start.y} C ${start.x + startBend} ${start.y}, ${end.x + endBend} ${end.y}, ${end.x} ${end.y}`,
      );
      path.setAttribute('class', 'edge');
      path.dataset.from = edge.from;
      path.dataset.to = edge.to;
      el.edges.appendChild(path);

      // A small arrowhead at the referenced end, so the direction of the
      // relationship is readable.
      const head = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const direction = end.side === 'right' ? 1 : -1;
      head.setAttribute(
        'd',
        `M ${end.x} ${end.y} l ${direction * 7} -3.5 l 0 7 z`,
      );
      head.setAttribute('class', 'edge-head');
      head.dataset.from = edge.from;
      head.dataset.to = edge.to;
      el.edges.appendChild(head);
    }
  }

  /** Where an edge attaches to a card, given which card it is heading toward. */
  function anchor(node, column, towards) {
    const index = node.table.columns.findIndex((c) => c.name === column);
    const visible = index >= 0 && index < MAX_COLUMNS ? index : -1;

    const y =
      visible >= 0
        ? node.y + HEAD_HEIGHT + visible * ROW_HEIGHT + ROW_HEIGHT / 2
        : node.y + node.height / 2;

    const side = towards.x + towards.width / 2 >= node.x + node.width / 2 ? 'right' : 'left';
    return { x: side === 'right' ? node.x + node.width : node.x, y, side };
  }

  function contentBounds() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes.values()) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    }

    if (!Number.isFinite(minX)) {
      return { minX: 0, minY: 0, width: 0, height: 0 };
    }
    return { minX, minY, width: maxX - minX, height: maxY - minY };
  }

  // ---- highlight and search ---------------------------------------------

  function applyHighlight() {
    const related = new Set();
    if (selected) {
      related.add(selected);
      for (const edge of edges) {
        if (edge.from === selected) related.add(edge.to);
        if (edge.to === selected) related.add(edge.from);
      }
    }

    const matcher = query.trim().toLowerCase();

    for (const card of el.tables.querySelectorAll('.table')) {
      const name = /** @type {HTMLElement} */ (card).dataset.table || '';
      const table = nodes.get(name)?.table;

      const matches =
        matcher.length > 0 &&
        (name.toLowerCase().includes(matcher) ||
          (table?.columns ?? []).some((c) => c.name.toLowerCase().includes(matcher)));

      card.classList.toggle('selected', name === selected);
      card.classList.toggle('match', matches);
      card.classList.toggle(
        'dimmed',
        (selected !== null && !related.has(name)) || (matcher.length > 0 && !matches),
      );

      for (const columnEl of card.querySelectorAll('.col')) {
        const columnName = (/** @type {HTMLElement} */ (columnEl).dataset.column || '').toLowerCase();
        columnEl.classList.toggle('hit', matcher.length > 0 && columnName.includes(matcher));
      }
    }

    for (const line of el.edges.querySelectorAll('.edge, .edge-head')) {
      const from = /** @type {SVGElement} */ (line).dataset.from || '';
      const to = /** @type {SVGElement} */ (line).dataset.to || '';
      const touches = selected !== null && (from === selected || to === selected);
      line.classList.toggle('active', touches);
      line.classList.toggle('dimmed', selected !== null && !touches);
    }
  }

  el.search.addEventListener('input', () => {
    query = el.search.value;
    applyHighlight();
  });

  el.newTable.addEventListener('click', () => vscode.postMessage({ type: 'newTable' }));

  el.exportDiagram.addEventListener('click', () =>
    vscode.postMessage({ type: 'exportDiagram' }),
  );

  el.focus.addEventListener('change', () => {
    focusDepth = Number(el.focus.value);
    build();
    applyHighlight();
  });

  el.schemaFilter.addEventListener('change', () => {
    schemaFilter = el.schemaFilter.value;
    selected = null;
    build();
  });

  el.overlay.addEventListener('change', () => setOverlay(el.overlay.value));

  el.fit.addEventListener('click', fit);
  el.relayout.addEventListener('click', () => {
    // Explicitly throws away a hand-made arrangement, which is the only reason
    // anyone presses this.
    vscode.setState(undefined);
    layout();
    renderCards();
    renderEdges();
    applyHighlight();
    fit();
  });

  el.stage.addEventListener('click', () => {
    if (selected !== null) {
      selected = null;
      applyHighlight();
    }
  });

  function populateSchemaFilter() {
    const schemas = snapshot?.schemas ?? [];
    el.schemaFilter.replaceChildren();

    const all = document.createElement('option');
    all.value = '';
    all.textContent = schemas.length > 1 ? 'All schemas' : 'public';
    el.schemaFilter.appendChild(all);

    for (const schema of schemas) {
      const option = document.createElement('option');
      option.value = schema;
      option.textContent = schema;
      el.schemaFilter.appendChild(option);
    }
    el.schemaFilter.hidden = schemas.length <= 1;
  }

  // ---- pan and zoom ------------------------------------------------------

  function apply() {
    el.canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  }

  function fit() {
    const bounds = contentBounds();
    if (bounds.width === 0) {
      return;
    }

    const frame = el.stage.getBoundingClientRect();
    const margin = 48;
    const scale = Math.min(
      (frame.width - margin) / bounds.width,
      (frame.height - margin) / bounds.height,
      1.15,
    );

    view.scale = Math.max(0.12, scale);
    view.x = (frame.width - bounds.width * view.scale) / 2 - bounds.minX * view.scale;
    view.y = (frame.height - bounds.height * view.scale) / 2 - bounds.minY * view.scale;
    apply();
  }

  let panning = false;
  let panStart = { x: 0, y: 0, viewX: 0, viewY: 0 };

  el.stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    panning = true;
    panStart = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
    el.stage.classList.add('panning');
    el.stage.setPointerCapture(event.pointerId);
  });

  el.stage.addEventListener('pointermove', (event) => {
    if (!panning) {
      return;
    }
    view.x = panStart.viewX + (event.clientX - panStart.x);
    view.y = panStart.viewY + (event.clientY - panStart.y);
    apply();
  });

  const endPan = (event) => {
    if (!panning) {
      return;
    }
    panning = false;
    el.stage.classList.remove('panning');
    if (event.pointerId !== undefined && el.stage.hasPointerCapture(event.pointerId)) {
      el.stage.releasePointerCapture(event.pointerId);
    }
  };

  el.stage.addEventListener('pointerup', endPan);
  el.stage.addEventListener('pointercancel', endPan);

  el.stage.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const frame = el.stage.getBoundingClientRect();
      const px = event.clientX - frame.left;
      const py = event.clientY - frame.top;

      const factor = Math.exp(-event.deltaY * 0.0016);
      const next = Math.min(2.5, Math.max(0.08, view.scale * factor));

      // Keep the point under the cursor stationary while zooming.
      view.x = px - ((px - view.x) / view.scale) * next;
      view.y = py - ((py - view.y) / view.scale) * next;
      view.scale = next;
      apply();
    },
    { passive: false },
  );

  window.addEventListener('resize', () => {
    // Only refit when nothing is being inspected, so a resize does not throw
    // away where the reader had navigated to.
    if (selected === null && query.length === 0) {
      fit();
    }
  });

  // ---- formatting --------------------------------------------------------

  function abbreviate(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M rows`;
    if (n >= 1_000) return `${Math.round(n / 1000)}k rows`;
    return `${n} ${n === 1 ? 'row' : 'rows'}`;
  }

  function bytes(value) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = value;
    let unit = 0;
    while (n >= 1024 && unit < units.length - 1) {
      n /= 1024;
      unit++;
    }
    return `${n < 10 && unit > 0 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`;
  }

  /** Broad family of a type, for colouring. Skimming beats reading. */
  function typeFamily(type) {
    const t = String(type).toLowerCase();
    if (/char|text|uuid|json|xml|name/.test(t)) return 't-text';
    if (/int|serial|numeric|decimal|real|double|float|money/.test(t)) return 't-number';
    if (/timestamp|date|time|interval/.test(t)) return 't-time';
    if (/bool/.test(t)) return 't-bool';
    return 't-other';
  }

  function shortType(type) {
    return type
      .replace('character varying', 'varchar')
      .replace('timestamp with time zone', 'timestamptz')
      .replace('timestamp without time zone', 'timestamp')
      .replace('double precision', 'float8')
      .replace('integer', 'int');
  }


  /**
   * Brings a table into view and says which one it is.
   *
   * Centring alone is not enough on a diagram of twenty-one cards: the view
   * moves, and you are left hunting for what changed. The pulse is what makes
   * it an answer rather than a rearrangement.
   */
  function locateTable(name) {
    const node = nodes.get(name);
    if (!node) {
      return false;
    }

    const frame = el.stage.getBoundingClientRect();
    view.scale = Math.max(view.scale, 0.75);
    view.x = frame.width / 2 - (node.x + node.width / 2) * view.scale;
    view.y = frame.height / 2 - (node.y + node.height / 2) * view.scale;
    apply();

    const card = node.el;
    if (card) {
      card.classList.remove('locating');
      // Reading offsetWidth forces the style to settle, so removing and adding
      // the class actually restarts the animation instead of being coalesced
      // into no change at all.
      void card.offsetWidth;
      card.classList.add('locating');
      setTimeout(() => card.classList.remove('locating'), 2000);
    }
    return true;
  }

  /**
   * Paints a traced join route onto the diagram.
   *
   * The path finder answers in SQL, which is the half you can run. This is the
   * half you can see: which tables it goes through, in what order, and which
   * relationships it uses to get there.
   */
  function highlightRoute(tables) {
    for (const card of el.tables.querySelectorAll('.table')) {
      card.classList.remove('on-route');
      const badge = card.querySelector('.route-step');
      if (badge) {
        badge.remove();
      }
    }
    for (const line of el.edges.querySelectorAll('.edge, .edge-head')) {
      line.classList.remove('route');
    }

    if (!tables || tables.length === 0) {
      return;
    }

    tables.forEach((name, position) => {
      const node = nodes.get(name);
      if (!node?.el) {
        return;
      }
      node.el.classList.add('on-route');

      // Numbered, because "which one is first" is the question a route answers
      // and a uniform highlight does not.
      const badge = document.createElement('span');
      badge.className = 'route-step';
      badge.textContent = String(position + 1);
      node.el.appendChild(badge);
    });

    const hops = new Set();
    for (let i = 0; i < tables.length - 1; i++) {
      hops.add(`${tables[i]}|${tables[i + 1]}`);
      hops.add(`${tables[i + 1]}|${tables[i]}`);
    }

    for (const line of el.edges.querySelectorAll('.edge, .edge-head')) {
      const key = `${line.dataset.from}|${line.dataset.to}`;
      if (hops.has(key)) {
        line.classList.add('route');
      }
    }
  }

  /** Marks the table whose drawer is open, so the two halves stay tied. */
  function markOpened(name) {
    for (const card of el.tables.querySelectorAll('.table')) {
      card.classList.toggle('opened', card.dataset.table === name);
    }
  }

// ---- overlays ----------------------------------------------------------

  /**
   * Colouring the diagram by a measurement.
   *
   * The diagram already says what the schema is. What it cannot say is where
   * the weight sits — which of forty tables holds ninety per cent of the rows,
   * which one has not been vacuumed since March, which foreign key has nothing
   * behind it. Those are all one number per table, and one number per table is
   * exactly what a colour scale is for: the answer arrives before you have
   * read a single name.
   *
   * Scaled by rank rather than by value. Table sizes are almost always a power
   * law — one table with forty million rows and thirty with a few thousand —
   * and a linear scale on that paints one table red and everything else the
   * same shade of nothing.
   */

  /** @type {string} */
  let overlay = 'none';
  /** @type {any} */
  let health = null;
  let healthRequested = false;

  const OVERLAYS = {
    rows: {
      label: 'rows',
      needsHealth: false,
      value: (table) => table.rows,
      format: (value) => `${abbreviate(value)} rows`,
    },
    bytes: {
      label: 'total size on disk',
      needsHealth: false,
      value: (table) => table.bytes,
      format: (value) => bytes(value),
    },
    dead: {
      label: 'dead rows waiting to be vacuumed',
      needsHealth: true,
      value: (table, entry) => (entry ? entry.deadRows : 0),
      format: (value) => `${abbreviate(value)} dead`,
    },
    stale: {
      label: 'rows changed since the planner last looked',
      needsHealth: true,
      value: (table, entry) => (entry ? entry.modifiedSinceAnalyze : 0),
      format: (value) => `${abbreviate(value)} unanalysed`,
    },
    fk: {
      label: 'foreign keys with no index behind them',
      needsHealth: true,
      value: (table) => unindexedCount(table.qualified),
      format: (value) => (value === 1 ? '1 unindexed key' : `${value} unindexed keys`),
    },
  };

  function setOverlay(next) {
    overlay = next;

    if (next !== 'none' && OVERLAYS[next] && OVERLAYS[next].needsHealth && !health) {
      if (!healthRequested) {
        healthRequested = true;
        vscode.postMessage({ type: 'health' });
      }
      el.overlayNote.hidden = false;
      el.overlayNote.textContent = 'Reading the statistics…';
      return;
    }

    applyOverlay();
  }

  function applyOverlay() {
    const definition = OVERLAYS[overlay];

    if (!definition) {
      for (const node of nodes.values()) {
        if (node.el) {
          node.el.classList.remove('overlaid');
          node.el.style.removeProperty('--heat');
          restoreMeta(node);
        }
      }
      el.overlayNote.hidden = true;
      return;
    }

    const entries = [...nodes.values()].map((node) => ({
      node,
      value: Number(definition.value(node.table, healthFor(node.table.qualified)) || 0),
    }));

    // Rank rather than magnitude: with a power-law distribution a linear scale
    // paints one table red and leaves everything else indistinguishable.
    const ordered = [...entries].filter((entry) => entry.value > 0).sort((a, b) => a.value - b.value);
    const rankOf = new Map(ordered.map((entry, index) => [entry.node, index]));
    const span = Math.max(ordered.length - 1, 1);

    let highest = null;
    for (const entry of entries) {
      const card = entry.node.el;
      if (!card) {
        continue;
      }
      if (entry.value <= 0) {
        card.classList.remove('overlaid');
        card.style.removeProperty('--heat');
        restoreMeta(entry.node);
        continue;
      }
      card.classList.add('overlaid');
      card.style.setProperty('--heat', String(rankOf.get(entry.node) / span));
      setMeta(entry.node, definition.format(entry.value));
      if (!highest || entry.value > highest.value) {
        highest = entry;
      }
    }

    el.overlayNote.hidden = false;
    el.overlayNote.textContent = describeOverlay(definition, ordered.length, highest);
  }

  function describeOverlay(definition, coloured, highest) {
    if (coloured === 0) {
      return `Nothing to colour: no table has any ${definition.label}.`;
    }

    const parts = [
      `Shaded by ${definition.label}, darkest first.`,
      highest
        ? `${highest.node.table.qualified} leads with ${definition.format(highest.value)}.`
        : '',
    ];

    // The window the statistics cover is not a footnote. "Never scanned" and
    // "not scanned since the server came up an hour ago" are the same number.
    if (definition.needsHealth && health && health.statsSince) {
      parts.push(`Statistics collected since ${new Date(health.statsSince).toLocaleString()}.`);
    }
    return parts.filter(Boolean).join(' ');
  }

  function healthFor(qualified) {
    if (!health) {
      return null;
    }
    const bare = qualified.includes('.') ? qualified.slice(qualified.indexOf('.') + 1) : qualified;
    return health.tables.find((table) => table.table === bare || table.table === qualified) ?? null;
  }

  function unindexedCount(qualified) {
    if (!health) {
      return 0;
    }
    const bare = qualified.includes('.') ? qualified.slice(qualified.indexOf('.') + 1) : qualified;
    return health.unindexedForeignKeys.filter(
      (key) => key.table === bare || key.table === qualified,
    ).length;
  }

  function setMeta(node, text) {
    const meta = node.el?.querySelector('.table-meta');
    if (meta) {
      meta.textContent = text;
    }
  }

  function restoreMeta(node) {
    setMeta(node, `${abbreviate(node.table.rows)} · ${bytes(node.table.bytes)}`);
  }

  // ---- bridge ------------------------------------------------------------

  /**
   * The small surface the editor half needs.
   *
   * The diagram and the editor live in separate files because they are separate
   * concerns — one draws a schema, the other accumulates changes to it — and
   * this is the whole of what passes between them. Keeping it to four functions
   * is what stops the editor reaching into the layout and the layout growing
   * opinions about editing.
   */
  window.__dryrunSchema = {
    /** Draws a different snapshot: used to flip between now and after. */
    render(next) {
      snapshot = next;
      build();
    },
    /** The schema as the database actually has it. */
    baseline() {
      return baselineSnapshot;
    },
    tablesEl() {
      return el.tables;
    },
    shortType(type) {
      return shortType(type);
    },
    /**
     * Registers what happens when a card is clicked rather than dragged.
     *
     * A callback rather than a DOM event, because the card stops its own click
     * from propagating — it has to, or the stage's handler would immediately
     * clear the selection the click just made — and so nothing above the card
     * ever sees it.
     */
    onTableActivate(handler) {
      onActivate = handler;
    },
    /**
     * Sends a message to the extension.
     *
     * `acquireVsCodeApi()` may be called exactly once per webview, and this
     * file has already called it. A second call throws, which would take out
     * whichever script ran second in its entirety — so the handle is shared
     * rather than re-acquired.
     */
    postMessage(message) {
      vscode.postMessage(message);
    },
    /** Centres the view on a table and pulses it. Returns false if unknown. */
    locate(name) {
      return locateTable(name);
    },
    /** Paints a traced join route across the diagram. */
    highlightRoute(tables) {
      highlightRoute(tables);
    },
    /** Marks which table currently has its drawer open. */
    markOpened(name) {
      markOpened(name);
    },
  };
})();
