// @ts-check
/**
 * The visual editor.
 *
 * Click a table to open it, change it, and watch the pending changes
 * accumulate. Nothing here writes to the database: this file sends intent —
 * "drop this column", "set this cell to that" — and renders what the extension
 * sends back. Every consequence shown was measured by really running the
 * statement against the real data inside a transaction that was rolled back.
 *
 * The order is deliberate and enforced on the extension side. Edit, preview,
 * then apply. Clicking "drop column" is far easier than typing the statement,
 * and making a destructive act easier without making its consequences more
 * visible is how you build a footgun.
 */

(function () {
  const host = window.__dryrunSchema;

  // NOT acquireVsCodeApi(). It may be called exactly once per webview, and
  // schema.js has already called it — a second call throws, and because it
  // would throw on the first line of this file, nothing below would run at
  // all. That is precisely what happened: the diagram worked perfectly while
  // every part of the editor was silently dead, including the click handler
  // that opens this drawer.
  const vscode = {
    postMessage: (message) => host.postMessage(message),
  };

  /** @type {any} */
  let detail = null;
  /** @type {any[]} */
  let changes = [];
  /** @type {any} */
  let diff = null;
  /** @type {any} */
  let projected = null;
  /** @type {any[]} */
  let findings = [];
  let previewSummary = '';
  let canApply = false;
  /** How many tables the last preview marked, for the "show me where" button. */
  let affectedCount = 0;
  let previewDestructive = false;
  let showingAfter = false;
  /** True when the pending list came from a file rather than from clicking. */
  let readOnly = false;
  let source = '';

  const ui = {
    drawer: /** @type {HTMLElement} */ (document.getElementById('drawer')),
    changes: /** @type {HTMLElement} */ (document.getElementById('changes')),
    changesBody: /** @type {HTMLElement} */ (document.getElementById('changes-body')),
    changesTitle: /** @type {HTMLElement} */ (document.getElementById('changes-title')),
    preview: /** @type {HTMLButtonElement} */ (document.getElementById('preview')),
    apply: /** @type {HTMLButtonElement} */ (document.getElementById('apply')),
    discard: /** @type {HTMLButtonElement} */ (document.getElementById('discard')),
    exportSql: /** @type {HTMLButtonElement} */ (document.getElementById('export')),
    exportDown: /** @type {HTMLButtonElement} */ (document.getElementById('export-down')),
    showAffected: /** @type {HTMLButtonElement} */ (document.getElementById('show-affected')),
    toggle: /** @type {HTMLElement} */ (document.getElementById('view-toggle')),
    before: /** @type {HTMLButtonElement} */ (document.getElementById('view-before')),
    after: /** @type {HTMLButtonElement} */ (document.getElementById('view-after')),
  };

  window.addEventListener('message', (event) => {
    try {
      handle(event.data);
    } catch (error) {
      // A thrown handler removes nothing and breaks everything: the listener
      // survives, but this panel would sit there ignoring every message after
      // it with nothing on screen to say why. Both halves matter — keep
      // listening, and put the failure where someone can see it.
      reportFailure(error);
    }
  });

  /**
   * Shows a handler failure rather than letting it disappear.
   *
   * The drawer is the loudest place available that does not destroy whatever
   * the user was looking at, and the console line is for the case where the
   * drawer itself is what broke.
   */
  function reportFailure(error) {
    const description = error && error.message ? error.message : String(error);
    console.error('Dry Run: ' + description, error);
    try {
      openDrawer(errorDrawer('Something went wrong', description));
    } catch {
      // Nothing further to try; the console line above is the record.
    }
  }

  function handle(message) {
    switch (message.type) {
      case 'tableLoading':
        openDrawer(loadingDrawer(message.table));
        break;

      case 'tableDetail':
        detail = message.detail;
        renderDrawer();
        host.markOpened(detail.table);
        break;

      case 'tableError':
        detail = null;
        openDrawer(errorDrawer(message.table, message.message));
        break;

      case 'joinPath':
        renderJoinPath(message);
        break;

      case 'changeset': {
        readOnly = Boolean(message.readOnly);
        source = message.source || '';
        const hadStructure = changesStructure(changes);
        changes = message.changes;
        diff = message.diff;
        projected = message.projected;

        // The first structural change flips the picture to what it would
        // become. "I added a column and pressed preview and nothing happened"
        // — the column was in the After view all along, behind a toggle in the
        // corner nobody had reason to press. The change is the thing you asked
        // to see, so it is shown.
        if (!showingAfter && !hadStructure && changesStructure(changes)) {
          setViewMode(true);
        } else if (showingAfter) {
          // Already there: redraw, since the projection has moved.
          setViewMode(true);
        }
        // Any edit invalidates the last preview: what was measured is no longer
        // what would run.
        findings = [];
        previewSummary = '';
        canApply = false;
        affectedCount = 0;
        host.markAffected({});
        renderChanges();
        markPending();
        break;
      }

      case 'previewStarted':
        previewSummary = 'Measuring against your data…';
        findings = [];
        affectedCount = 0;
        host.markAffected({});
        renderChanges();
        break;

      case 'preview':
        findings = message.findings;
        previewSummary = message.summary;
        previewDestructive = message.destructive;
        canApply = message.canApply;
        // Where, not just what. A sentence at the bottom of the screen cannot
        // point at one card among twenty-one.
        affectedCount = Object.keys(message.affected || {}).length;
        host.markAffected(message.affected || {});
        renderChanges();
        break;

      case 'previewStale':
        // A preview that finished after the changeset moved on. Its numbers
        // describe something that is no longer there, so they are not shown.
        findings = [];
        canApply = false;
        previewSummary = message.message;
        affectedCount = 0;
        host.markAffected({});
        renderChanges();
        break;

      case 'applied':
        previewSummary = `Applied ${message.applied} ${message.applied === 1 ? 'change' : 'changes'}.`;
        findings = [];
        canApply = false;
        renderChanges();
        break;

      case 'applyCancelled':
        previewSummary = 'Not applied. Nothing was changed.';
        renderChanges();
        break;

      case 'error':
        previewSummary = message.message;
        renderChanges();
        break;

      default:
        break;
    }
  }

  // ---- drawer ------------------------------------------------------------

  function openDrawer(content) {
    ui.drawer.hidden = false;
    ui.drawer.replaceChildren(content);
  }

  function closeDrawer() {
    ui.drawer.hidden = true;
    detail = null;
    host.markOpened(null);
    host.highlightRoute([]);
  }

  // Esc closes the drawer. Reaching for the small ✕ every time is the kind of
  // friction that makes people stop opening it.
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !ui.drawer.hidden) {
      closeDrawer();
    }
  });

  function loadingDrawer(table) {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'drawer-head';
    head.appendChild(text('span', 'drawer-title', table));
    head.appendChild(text('span', 'drawer-sub', 'loading…'));
    wrap.appendChild(head);
    return wrap;
  }

  function errorDrawer(table, message) {
    const wrap = document.createElement('div');

    const head = document.createElement('div');
    head.className = 'drawer-head';
    head.appendChild(text('span', 'drawer-title', table));

    const close = document.createElement('button');
    close.className = 'drawer-close';
    close.textContent = '✕';
    close.title = 'Close';
    close.addEventListener('click', closeDrawer);
    head.appendChild(close);
    wrap.appendChild(head);

    wrap.appendChild(text('div', 'empty-hint', message));
    return wrap;
  }

  /**
   * A table that exists only in the pending changes.
   *
   * Asking the database about it returns "table not found", which is true and
   * unhelpful — it is not missing, it has not been created yet. So this is
   * drawn from the projection instead of a query, and offers the only two
   * things that make sense on something that does not exist: add columns to
   * it, or drop the change that creates it.
   */
  function pendingTableDrawer(table) {
    const projectedTable = projected?.tables.find((t) => t.qualified === table);
    const wrap = document.createElement('div');

    const head = document.createElement('div');
    head.className = 'drawer-head';
    head.appendChild(text('span', 'drawer-title', table));
    head.appendChild(text('span', 'drawer-sub', 'not created yet'));

    const close = document.createElement('button');
    close.className = 'drawer-close';
    close.textContent = '✕';
    close.title = 'Close';
    close.addEventListener('click', closeDrawer);
    head.appendChild(close);
    wrap.appendChild(head);

    wrap.appendChild(
      text(
        'div',
        'empty-hint',
        'This table is part of your pending changes. It has no rows, indexes or ' +
          'constraints to read until the changes are applied.',
      ),
    );

    const columns = document.createElement('div');
    columns.className = 'drawer-section';
    columns.appendChild(text('h3', '', 'Columns so far'));

    for (const column of projectedTable?.columns ?? []) {
      const row = document.createElement('div');
      row.className = 'drawer-col';
      row.appendChild(text('span', 'name', column.name));
      row.appendChild(text('span', `type ${typeFamily(column.type)}`, column.type));
      if (column.isPrimaryKey) {
        row.appendChild(text('span', 'flag', 'PK'));
      }
      columns.appendChild(row);
    }
    wrap.appendChild(columns);

    // The add-column form works unchanged: an ADD COLUMN against a table
    // created earlier in the same changeset is exactly right, and the preview
    // runs them in order.
    detail = { table, columns: projectedTable?.columns ?? [] };
    wrap.appendChild(renderAddColumnSection());

    return wrap;
  }

  /** Broad family of a type, for colouring. Mirrors the diagram's own. */
  function typeFamily(type) {
    const t = String(type).toLowerCase();
    if (/char|text|uuid|json|xml|name/.test(t)) return 't-text';
    if (/int|serial|numeric|decimal|real|double|float|money/.test(t)) return 't-number';
    if (/timestamp|date|time|interval/.test(t)) return 't-time';
    if (/bool/.test(t)) return 't-bool';
    return 't-other';
  }

  /** True for a table that only exists in the pending changes. */
  function isPending(table) {
    const baseline = host.baseline();
    return (
      !baseline?.tables.some((t) => t.qualified === table) &&
      Boolean(projected?.tables.some((t) => t.qualified === table))
    );
  }

  function renderDrawer() {
    if (!detail) {
      return;
    }

    const wrap = document.createElement('div');

    const head = document.createElement('div');
    head.className = 'drawer-head';
    head.appendChild(text('span', 'drawer-title', detail.table));
    head.appendChild(
      text(
        'span',
        'drawer-sub',
        `${detail.rowsEstimated ? '≈' : ''}${Number(detail.rows).toLocaleString()} rows`,
      ),
    );

    const close = document.createElement('button');
    close.className = 'drawer-close';
    close.textContent = '✕';
    close.title = 'Close';
    close.addEventListener('click', closeDrawer);
    head.appendChild(close);
    wrap.appendChild(head);

    wrap.appendChild(renderTableActions());
    wrap.appendChild(renderColumnsSection());
    wrap.appendChild(renderAddColumnSection());
    if (detail.indexes.length) {
      wrap.appendChild(renderListSection('Indexes', detail.indexes.map((i) => i.definition)));
    }
    if (detail.constraints.length) {
      wrap.appendChild(
        renderListSection(
          'Constraints',
          detail.constraints.map((c) => `${c.name}: ${c.definition}`),
        ),
      );
    }
    wrap.appendChild(renderPathSection());
    wrap.appendChild(renderDataSection());

    openDrawer(wrap);
  }

  /**
   * What you can do to the table as a whole.
   *
   * Separated from the column list because these are a different scale of
   * action, and because "where is this on the diagram" is the question you have
   * the moment a drawer opens over a diagram of twenty-one cards.
   */
  function renderTableActions() {
    const bar = document.createElement('div');
    bar.className = 'drawer-actions';

    // Re-reading is now something you ask for rather than something that
    // happens every time you click the card, so it needs a way to be asked.
    bar.appendChild(
      miniButton('Refresh', () => {
        const table = detail.table;
        detail = null;
        openTable(table);
      }),
    );

    bar.appendChild(
      miniButton('Show on diagram', () => {
        if (!host.locate(detail.table)) {
          // Focus mode or a schema filter can have hidden it entirely, and
          // silently doing nothing would read as a broken button.
          vscode.postMessage({ type: 'notDrawn', tables: [detail.table] });
        }
      }),
    );

    bar.appendChild(
      miniButton('Rename table', () => {
        vscode.postMessage({ type: 'renameTable', table: detail.table });
      }),
    );

    bar.appendChild(
      miniButton(
        'Drop table',
        () => {
          // The question is asked by the editor, which is the only place it can
          // be asked at all. Dropping a table is the most destructive thing in
          // here, and a button that does it on one press is a button someone
          // eventually hits by accident.
          vscode.postMessage({
            type: 'dropTable',
            table: detail.table,
            rows: Number(detail.rows),
          });
        },
        true,
      ),
    );

    return bar;
  }

  function renderColumnsSection() {
    const section = document.createElement('div');
    section.className = 'drawer-section';
    section.appendChild(text('h3', '', 'Columns'));

    for (const column of detail.columns) {
      const row = document.createElement('div');
      row.className = 'drawer-col';

      row.appendChild(text('span', 'name', column.name));
      row.appendChild(text('span', 'type', host.shortType(column.type)));
      if (column.isPrimaryKey) {
        row.appendChild(text('span', 'flag', 'PK'));
      } else if (!column.nullable) {
        row.appendChild(text('span', 'flag', 'NOT NULL'));
      }

      const actions = document.createElement('span');
      actions.className = 'row-actions';

      actions.appendChild(
        miniButton('Rename', () => {
          vscode.postMessage({
            type: 'renameColumn',
            table: detail.table,
            column: column.name,
          });
        }),
      );

      actions.appendChild(
        miniButton('Type', () => {
          vscode.postMessage({
            type: 'changeType',
            table: detail.table,
            column: column.name,
            from: column.type,
          });
        }),
      );

      actions.appendChild(
        miniButton(column.nullable ? 'Require' : 'Allow null', () => {
          addEdit({
            kind: 'set_nullability',
            table: detail.table,
            column: column.name,
            nullable: !column.nullable,
          });
        }),
      );

      // The primary key has no drop button. Dropping it is legal SQL and almost
      // never what someone means by clicking a small button next to a column.
      if (!column.isPrimaryKey) {
        actions.appendChild(
          miniButton(
            'Drop',
            () => addEdit({ kind: 'drop_column', table: detail.table, column: column.name }),
            true,
          ),
        );
      }

      row.appendChild(actions);
      section.appendChild(row);
    }

    return section;
  }

  function renderAddColumnSection() {
    const section = document.createElement('div');
    section.className = 'drawer-section';
    section.appendChild(text('h3', '', 'Add a column'));

    const form = document.createElement('div');
    form.className = 'form-row';

    const name = document.createElement('input');
    name.type = 'text';
    name.placeholder = 'name';

    const type = document.createElement('select');
    for (const option of [
      'text',
      'integer',
      'bigint',
      'boolean',
      'timestamptz',
      'date',
      'numeric',
      'jsonb',
      'uuid',
    ]) {
      const opt = document.createElement('option');
      opt.value = option;
      opt.textContent = option;
      type.appendChild(opt);
    }

    const nullable = document.createElement('select');
    for (const pair of [
      ['true', 'nullable'],
      ['false', 'not null'],
    ]) {
      const opt = document.createElement('option');
      opt.value = pair[0];
      opt.textContent = pair[1];
      nullable.appendChild(opt);
    }

    const add = document.createElement('button');
    add.className = 'mini';
    add.type = 'button';
    add.textContent = 'Add';
    add.addEventListener('click', () => {
      if (!name.value.trim()) {
        return;
      }
      addEdit({
        kind: 'add_column',
        table: detail.table,
        column: name.value.trim(),
        type: type.value,
        nullable: nullable.value === 'true',
      });
      name.value = '';
    });

    form.append(name, type, nullable, add);
    section.appendChild(form);
    section.appendChild(
      text(
        'div',
        'hint',
        'A NOT NULL column with no default fails on a table that already has rows. ' +
          'Preview will say so, with the count.',
      ),
    );
    return section;
  }

  /**
   * Route-finding, from the open table to any other.
   *
   * The answer is a JOIN you can copy, because knowing that users reaches
   * products through orders and order_items is only half of what you wanted;
   * the other half is not having to write it out.
   */
  function renderPathSection() {
    const section = document.createElement('div');
    section.className = 'drawer-section';
    section.id = 'path-section';
    section.appendChild(text('h3', '', 'Find a route to'));

    const form = document.createElement('div');
    form.className = 'form-row';

    const target = document.createElement('select');
    target.id = 'path-target';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'another table…';
    target.appendChild(blank);

    for (const name of tableNames()) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      target.appendChild(option);
    }

    target.addEventListener('change', () => {
      if (target.value) {
        vscode.postMessage({ type: 'findPath', from: detail.table, to: target.value });
      }
    });

    form.appendChild(target);
    section.appendChild(form);
    section.appendChild(text('div', 'path-result hint', ''));
    return section;
  }

  function tableNames() {
    const baseline = host.baseline();
    return baseline ? baseline.tables.map((t) => t.qualified) : [];
  }

  function renderJoinPath(message) {
    const result = document.querySelector('.path-result');
    if (!result) {
      return;
    }

    if (!message.found) {
      result.textContent =
        'No route: nothing connects these two through a foreign key.';
      return;
    }

    result.replaceChildren();
    const joins = `${message.joins} ${message.joins === 1 ? 'join' : 'joins'}`;
    result.appendChild(text('div', '', `${joins}: ${message.tables.join(' → ')}`));
    result.appendChild(text('pre', 'definition', message.sql));

    // The SQL is the half you can run; the diagram is the half you can see.
    // Numbered stops on the cards, and the hops between them lit up.
    host.highlightRoute(message.tables);

    const actions = document.createElement('div');
    actions.className = 'form-row';
    actions.appendChild(
      miniButton('Copy SQL', () => {
        void navigator.clipboard?.writeText(message.sql);
      }),
    );
    actions.appendChild(
      miniButton('Clear route', () => {
        host.highlightRoute([]);
      }),
    );
    result.appendChild(actions);
  }

  function renderListSection(title, lines) {
    const section = document.createElement('div');
    section.className = 'drawer-section';
    section.appendChild(text('h3', '', title));
    for (const line of lines) {
      section.appendChild(text('div', 'definition', line));
    }
    return section;
  }

  /**
   * Real rows, editable in place.
   *
   * Editing a cell needs the row's real primary key rather than its rendering,
   * which is why the extension sends both. A table with no primary key is
   * read-only here: without a key there is no way to write a WHERE meaning
   * "this row and no other", and guessing is how you update four thousand.
   */
  function renderDataSection() {
    const section = document.createElement('div');
    section.className = 'drawer-section';

    section.appendChild(
      text(
        'h3',
        '',
        detail.filter
          ? `Rows matching "${detail.filter}" (${detail.sample.length})`
          : `Rows (first ${detail.sample.length})`,
      ),
    );

    // Finding one row among a quarter of a million is the difference between
    // editing your data and editing its first 25 rows.
    const find = document.createElement('div');
    find.className = 'form-row';

    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Find a row — any column, any value';
    search.value = detail.filter || '';
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        openTable(detail.table, search.value);
      }
    });

    const go = document.createElement('button');
    go.className = 'mini';
    go.type = 'button';
    go.textContent = 'Find';
    go.addEventListener('click', () => openTable(detail.table, search.value));

    find.append(search, go);
    section.appendChild(find);

    if (detail.sample.length === 0) {
      section.appendChild(
        text(
          'div',
          'hint',
          detail.filter ? 'Nothing matched that.' : 'This table is empty.',
        ),
      );
      return section;
    }

    const editable = detail.primaryKey.length > 0;
    // The declared columns, plus anything the rows actually carry.
    //
    // For SQL those are always the same list. For MongoDB they are not: the
    // field list is inferred from a sample of documents and the rows shown are
    // a different query, so a document can hold a field the inference missed.
    // Showing a row while quietly hiding part of it is the one thing a table
    // of real data must not do.
    const columns = detail.columns.map((c) => c.name);
    for (const row of detail.sample || []) {
      for (const key of Object.keys(row)) {
        if (!columns.includes(key)) {
          columns.push(key);
        }
      }
    }

    const wrap = document.createElement('div');
    wrap.className = 'data-table-wrap';
    const table = document.createElement('table');
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const column of columns) {
      headRow.appendChild(text('th', '', column));
    }
    headRow.appendChild(text('th', '', ''));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const rawRows = detail.sampleRaw || detail.sample;
    detail.sample.forEach((row, index) => {
      // Falls back to the display row rather than throwing. Editing a cell
      // needs the real value, and a drawer that renders without the raw rows
      // is worth more than one that renders nothing at all.
      const raw = rawRows[index] || {};
      const tr = document.createElement('tr');
      tr.className = 'data-row';

      for (const column of columns) {
        const td = document.createElement('td');
        td.textContent = row[column];
        if (editable) {
          td.className = 'editable';
          td.title = 'Click to edit';
          td.addEventListener('click', () => beginCellEdit(td, column, raw));
        }
        tr.appendChild(td);
      }

      const actions = document.createElement('td');
      if (editable) {
        const holder = document.createElement('span');
        holder.className = 'row-actions';
        holder.appendChild(
          miniButton(
            'Delete',
            () => addEdit({ kind: 'delete_row', table: detail.table, key: keyOf(raw) }),
            true,
          ),
        );
        actions.appendChild(holder);
      }
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    section.appendChild(wrap);

    if (!editable) {
      section.appendChild(
        text(
          'div',
          'hint',
          'This table has no primary key, so a single row cannot be identified. Rows here are read-only.',
        ),
      );
    }

    return section;
  }

  function keyOf(raw) {
    const key = {};
    for (const column of detail.primaryKey) {
      key[column] = raw[column];
    }
    return key;
  }

  function beginCellEdit(td, column, raw) {
    if (td.querySelector('input')) {
      return;
    }

    const original = td.textContent;
    const wasNull = original === '∅';
    const input = document.createElement('input');
    input.className = 'cell-input';
    input.value = wasNull ? '' : original;

    let settled = false;
    const settle = (commit) => {
      if (settled) {
        return;
      }
      settled = true;
      td.textContent = original;

      if (!commit || input.value === (wasNull ? '' : original)) {
        return;
      }
      addEdit({
        kind: 'update_row',
        table: detail.table,
        key: keyOf(raw),
        // An emptied cell means NULL rather than an empty string: they are
        // different values and conflating them silently corrupts data.
        set: { [column]: input.value === '' ? null : input.value },
      });
    };

    input.addEventListener('blur', () => settle(true));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        settle(true);
      } else if (event.key === 'Escape') {
        settle(false);
      }
    });

    td.replaceChildren(input);
    input.focus();
    input.select();
  }

  // ---- pending changes ---------------------------------------------------

  function addEdit(edit) {
    vscode.postMessage({ type: 'addEdit', edit });
  }

  function removeEdit(index) {
    vscode.postMessage({ type: 'removeEdit', index });
  }

  function renderChanges() {
    const has = changes.length > 0;
    ui.changes.hidden = !has;
    ui.toggle.hidden = !has;

    if (!has) {
      if (showingAfter) {
        setViewMode(false);
      }
      ui.changesBody.replaceChildren();
      return;
    }

    ui.changesTitle.textContent = readOnly
      ? `${source} — ${changes.length} ${changes.length === 1 ? 'change' : 'changes'}`
      : `${changes.length} pending ${changes.length === 1 ? 'change' : 'changes'}`;

    // A file's changes belong to whatever migration tool owns it, so the
    // buttons that would act on them are not offered.
    ui.apply.hidden = readOnly || !canApply;
    // Keyed on what is actually marked. A preview can land on a table without
    // producing a row for it, and a button that flies to nothing is worse than
    // no button.
    ui.showAffected.hidden = affectedCount === 0;
    ui.preview.hidden = readOnly;
    ui.discard.hidden = readOnly;
    ui.exportSql.hidden = readOnly;
    ui.exportDown.hidden = readOnly;
    ui.preview.textContent = findings.length > 0 ? 'Preview again' : 'Preview';

    const body = document.createDocumentFragment();

    if (previewSummary) {
      body.appendChild(text('div', 'summary-line', previewSummary));
    }

    for (const change of changes) {
      // Paired on the edit, not on a position. The two agree only while every
      // edit produces exactly one statement, and nothing enforces that — a
      // mismatch would attach a measurement to the wrong change, silently.
      const finding = findings.find((f) =>
        f.editIndex === undefined ? f.statementIndex === change.index : f.editIndex === change.index,
      );

      if (finding) {
        // Once measured, the row leads with what it will actually do rather
        // than with what was asked for.
        const row = document.createElement('div');
        row.className = 'verdict';
        row.appendChild(text('span', `verdict-badge ${finding.severity}`, finding.headline));

        const middle = document.createElement('span');
        middle.className = 'detail';
        middle.appendChild(text('div', '', change.label));
        middle.appendChild(text('div', 'sql', finding.detail));
        row.appendChild(middle);
        row.appendChild(miniButton('Remove', () => removeEdit(change.index), true));
        body.appendChild(row);
        continue;
      }

      const row = document.createElement('div');
      row.className = 'change';
      row.appendChild(text('span', 'label', change.label));
      row.appendChild(text('code', 'sql', change.sql));
      row.appendChild(miniButton('Remove', () => removeEdit(change.index), true));
      body.appendChild(row);
    }

    if (diff) {
      for (const relationship of diff.relationships) {
        body.appendChild(text('div', 'hint', relationship.note));
      }
      if (diff.dataEdits > 0) {
        body.appendChild(
          text(
            'div',
            'hint',
            `${diff.dataEdits} row ${diff.dataEdits === 1 ? 'edit' : 'edits'} — these change ` +
              `data, not structure, so the diagram is unchanged by them.`,
          ),
        );
      }
    }

    ui.changesBody.replaceChildren(body);
  }

  ui.preview.addEventListener('click', () => vscode.postMessage({ type: 'previewChanges' }));
  ui.discard.addEventListener('click', () => vscode.postMessage({ type: 'clearEdits' }));
  ui.exportSql.addEventListener('click', () => vscode.postMessage({ type: 'exportSql' }));
  ui.exportDown.addEventListener('click', () => vscode.postMessage({ type: 'exportDown' }));

  ui.showAffected.addEventListener('click', () => {
    // Frames all of them at once. Centring on one is the wrong answer when a
    // changeset touches four cards in different corners.
    if (!host.frameAffected()) {
      vscode.postMessage({ type: 'notDrawn', tables: [] });
    }
  });

  ui.apply.addEventListener('click', () => {
    // Asked once, by the editor, in a modal that cannot be dismissed by muscle
    // memory. There used to be a `confirm()` here first — which a webview
    // cannot show, so it returned false and Apply did nothing at all for
    // exactly the destructive changesets it was meant to guard.
    vscode.postMessage({ type: 'applyChanges', confirmed: true });
  });

  /**
   * Whether a changeset contains anything the diagram can draw.
   *
   * A row edit changes data and leaves the picture alone, so flipping to the
   * "after" view for one would be a redraw of the identical thing.
   */
  function changesStructure(list) {
    return (list || []).some((change) => !/^(Update|Delete|Insert) /.test(change.label || ''));
  }

  // ---- before / after ----------------------------------------------------

  /**
   * Flipping between the schema as it is and the schema the changes ask for.
   *
   * Both pictures are drawn by the same code from the same shape of data, so
   * the "after" view cannot drift from the "before" one — it is the same
   * renderer given a projected snapshot.
   */
  function setViewMode(after) {
    showingAfter = after;
    ui.before.classList.toggle('active', !after);
    ui.after.classList.toggle('active', after);

    const next = after ? projected : host.baseline();
    if (next) {
      host.render(next);
    }
    markPending();
  }

  ui.before.addEventListener('click', () => setViewMode(false));
  ui.after.addEventListener('click', () => setViewMode(true));

  /**
   * Marks what the pending changes touch, on whichever picture is showing.
   *
   * On "Now" a doomed column is struck through, so you see what you are about
   * to lose in its current context. On "After changes" it is simply gone and
   * the additions are what stand out. Flipping between the two is the
   * comparison.
   */
  function markPending() {
    const tablesEl = host.tablesEl();
    if (!diff || !tablesEl) {
      return;
    }

    const dropped = new Set();
    const added = new Set();
    const altered = new Set();

    for (const column of diff.columns) {
      const id = `${column.table}.${column.column}`;
      if (column.change === 'removed') {
        dropped.add(id);
      } else if (column.change === 'added') {
        added.add(id);
      } else {
        altered.add(id);
      }
    }

    const tableChange = new Map(diff.tables.map((t) => [t.table, t.change]));

    for (const card of tablesEl.querySelectorAll('.table')) {
      const name = card.dataset.table || '';
      const change = tableChange.get(name);
      card.classList.toggle('will-drop', change === 'removed');
      card.classList.toggle('will-add', change === 'added');
      card.classList.toggle('will-alter', change === 'altered');

      for (const columnEl of card.querySelectorAll('.col')) {
        const id = `${name}.${columnEl.dataset.column || ''}`;
        columnEl.classList.toggle('will-drop', dropped.has(id));
        columnEl.classList.toggle('will-add', added.has(id));
        columnEl.classList.toggle('will-change', altered.has(id));
      }
    }
  }

  // ---- opening a table ---------------------------------------------------

  // The diagram tells us directly. Listening for the click on a parent does not
  // work: the card stops it propagating so that the stage does not clear the
  // selection the click just made, which means it never reaches anything above.
  host.onTableActivate((table) => {
    // Already on screen. Clicking the background and then the same table again
    // used to throw the drawer away and read the whole thing back from the
    // database — a round trip to redraw what was already there, with a
    // "loading…" flash in the middle of it. The drawer has a Refresh button
    // for when the answer might have changed.
    if (detail && detail.table === table && !ui.drawer.hidden) {
      host.markOpened(table);
      return;
    }
    openTable(table);
  });

  function openTable(table, filter) {
    // A table that does not exist yet cannot be read. Asking anyway returns
    // "table not found", which is true and unhelpful, and used to leave the
    // drawer on "loading…" for ever.
    if (isPending(table)) {
      openDrawer(pendingTableDrawer(table));
      host.markOpened(table);
      return;
    }
    vscode.postMessage({ type: 'openTable', table, filter: filter ?? '' });
  }

  // ---- failure reporting -------------------------------------------------

  /**
   * A thrown error in here used to be invisible.
   *
   * The diagram lives in another file and keeps working, so a failure in this
   * one looks exactly like a feature that was never built: you click a table
   * and nothing happens, with nothing in any log the user would think to open.
   * Now it says so, in the panel, where it cannot be missed.
   */
  window.addEventListener('error', (event) => {
    const status = document.getElementById('status');
    if (status) {
      status.hidden = false;
      status.textContent = 'The editor failed to start: ' + (event.message || 'unknown error');
    }
  });

  // ---- helpers -----------------------------------------------------------

  function text(tag, className, content) {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    element.textContent = content;
    return element;
  }

  function miniButton(label, onClick, danger) {
    const button = document.createElement('button');
    button.className = `mini${danger ? ' danger' : ''}`;
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }
})();
