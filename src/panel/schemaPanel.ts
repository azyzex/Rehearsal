import * as os from 'node:os';
import { describeError } from '../errors';
import * as vscode from 'vscode';
import { DatabaseAdapter, SchemaSnapshot } from '../adapters/types';
import { Thresholds, Severity } from '../analysis/types';
import { Edit } from '../edit/changeset';
import { captureRescue } from '../edit/rescue';
import { downMigration } from '../edit/down';
import { schemaPanelHtml } from './html';
import { htmlOptionsFor } from './htmlOptions';
import { ChangesetHistory } from '../edit/history';
import { diffSchemas, projectSchema } from '../edit/project';
import { EditSession } from '../edit/session';
import { findJoinPath } from '../analysis/joinPath';
import { toMermaid } from './mermaid';

/**
 * The schema explorer, and the visual editor living inside it.
 *
 * The whole database drawn as tables and relationships; click one to open it,
 * edit it, and watch the pending changes accumulate. Nothing is written until
 * the changes have been previewed and then explicitly applied.
 *
 * The controller owns the session and does all the talking to the database.
 * The webview holds no connection and issues no SQL — it sends intent and
 * renders what comes back.
 */

export interface SchemaHost {
  /** The live connection, or undefined when there is not one. */
  adapter(): DatabaseAdapter | undefined;
  thresholds(): Thresholds;
  /** Re-reads the schema after changes have been applied. */
  refresh(): Promise<void>;
  report(error: unknown): void;
  /** Where applied changesets are recorded, when the host keeps one. */
  history?: ChangesetHistory;
}

export class SchemaPanel {
  private static current: SchemaPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly session = new EditSession();
  private host: SchemaHost | undefined;
  private previewToken: string | undefined;
  private previewDestructive = false;
  /**
   * Bumped whenever the changeset changes.
   *
   * A preview started before the bump describes a changeset that no longer
   * exists, and its result is dropped rather than shown.
   */
  private generation = 0;
  /** The verdict the preview gave, kept for the history entry. */
  private previewSummary = '';
  /** The database being edited, as it should be named in the history. */
  private connectionName = '';
  /** The schema as read, kept so a migration impact can be projected from it. */
  private baseline: SchemaSnapshot | undefined;

  /** The open panel, when there is one. */
  static get open(): SchemaPanel | undefined {
    return SchemaPanel.current;
  }

  static show(context: vscode.ExtensionContext, host: SchemaHost): SchemaPanel {
    if (SchemaPanel.current) {
      SchemaPanel.current.host = host;
      SchemaPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return SchemaPanel.current;
    }
    SchemaPanel.current = new SchemaPanel(context, host);
    return SchemaPanel.current;
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    host: SchemaHost,
  ) {
    this.host = host;
    this.panel = vscode.window.createWebviewPanel(
      'dryrun.schema',
      'Database Schema',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );

    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-dark.svg'),
    };

    this.panel.webview.html = this.render();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message) => void this.onMessage(message)),
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  loading(connection: string): void {
    this.post({ type: 'loading', connection });
  }

  show(snapshot: SchemaSnapshot, connection: string): void {
    this.session.setBaseline(snapshot, this.host?.adapter()?.engine ?? 'postgres');
    this.baseline = snapshot;
    this.connectionName = connection;
    this.post({ type: 'schema', snapshot, connection });
    this.postChangeset();
  }

  fail(message: string): void {
    this.post({ type: 'failed', message });
  }

  /** True while a schema is loaded, so callers know there is a picture to mark. */
  get hasSchema(): boolean {
    return this.baseline !== undefined;
  }

  /**
   * Shows a migration file's impact on the real schema diagram.
   *
   * The same before/after machinery as a visual changeset, fed from a parsed
   * file instead — so a migration and a click get the identical treatment
   * rather than two implementations of "what will this look like afterwards"
   * that could disagree.
   *
   * Marked read-only: these changes belong to a file, and applying them is the
   * job of whatever migration tool owns it.
   */
  showMigrationImpact(options: {
    file: string;
    edits: readonly Edit[];
    labels: readonly string[];
    findings: readonly unknown[];
    summary: string;
  }): void {
    if (!this.baseline) {
      return;
    }

    const projected = projectSchema(this.baseline, options.edits);
    this.post({
      type: 'changeset',
      readOnly: true,
      source: options.file,
      changes: options.labels.map((label, index) => ({
        index,
        label,
        sql: '',
      })),
      diff: diffSchemas(this.baseline, projected, options.edits),
      projected,
      sql: '',
    });
    this.post({
      type: 'preview',
      findings: options.findings,
      summary: options.summary,
      destructive: false,
      blocking: false,
      canApply: false,
      // A migration file previewed with the explorer open lands on the diagram
      // too. There is no reason the picture should only work for changes made
      // by clicking — the question "where does this happen" is the same one.
      affected: affectedTables(
        options.findings as readonly {
          severity: Severity;
          classification: { table?: string };
        }[],
      ),
    });
  }

  // ---- message handling --------------------------------------------------

  private async onMessage(message: { type?: string; [key: string]: unknown }): Promise<void> {
    try {
      switch (message.type) {
        case 'openTable':
          await this.openTable(String(message.table), String(message.filter ?? ''));
          break;

        case 'addEdit':
          // Any edit invalidates the previous preview: what was measured is no
          // longer what would run.
          this.session.add(message.edit as Edit);
          this.clearPreview();
          this.postChangeset();
          break;

        case 'removeEdit':
          this.session.removeAt(Number(message.index));
          this.clearPreview();
          this.postChangeset();
          break;

        case 'clearEdits':
          this.session.clear();
          this.clearPreview();
          this.postChangeset();
          break;

        case 'previewChanges':
          await this.preview();
          break;

        case 'applyChanges':
          await this.apply(Boolean(message.confirmed));
          break;

        case 'exportSql':
          await this.exportSql();
          break;

        case 'exportDown':
          await this.exportDown();
          break;

        case 'exportDiagram':
          await this.exportDiagram();
          break;

        case 'newTable':
          await this.newTable();
          break;

        // Everything below is a question. It is asked here rather than in the
        // webview because a webview cannot ask one: VS Code renders it in a
        // sandboxed iframe without `allow-modals`, so `prompt()` returns null
        // and `confirm()` returns false without anything appearing on screen.
        // Rename, Type and Drop table did nothing at all, in every window, for
        // as long as they have existed.
        case 'renameTable':
          await this.renameTable(String(message.table));
          break;

        case 'renameColumn':
          await this.renameColumn(String(message.table), String(message.column));
          break;

        case 'changeType':
          await this.changeType(
            String(message.table),
            String(message.column),
            String(message.from ?? ''),
          );
          break;

        case 'dropTable':
          await this.dropTable(String(message.table), Number(message.rows ?? 0));
          break;

        case 'notDrawn':
          this.sayNotDrawn((message.tables as string[] | undefined) ?? []);
          break;

        case 'health':
          await this.sendHealth();
          break;

        case 'findPath':
          this.findPath(String(message.from), String(message.to));
          break;

        default:
          break;
      }
    } catch (error) {
      this.host?.report(error);
      this.post({ type: 'error', message: errorMessage(error) });
    }
  }

  private async openTable(table: string, filter = ''): Promise<void> {
    this.post({ type: 'tableLoading', table });

    try {
      const adapter = this.requireAdapter();
      const detail = await adapter.tableDetail(table, 25, filter);
      this.post({ type: 'tableDetail', detail: serialiseDetail(detail) });
    } catch (error) {
      // The drawer has to be told, or it sits on "loading…" for ever. A panel
      // that never resolves is worse than one that says it failed: the first
      // looks like a hang, the second like an answer.
      this.post({ type: 'tableError', table, message: errorMessage(error) });
    }
  }

  private async preview(): Promise<void> {
    const adapter = this.requireAdapter();
    if (this.session.isEmpty) {
      this.post({
        type: 'error',
        message: 'There are no pending changes to preview.',
      });
      return;
    }

    this.post({ type: 'previewStarted' });

    const startedAt = this.generation;
    const result = await this.session.preview(adapter, this.host!.thresholds());

    if (startedAt !== this.generation) {
      // Something was edited while this was running. Showing it would put a
      // measurement of the old changeset next to the new one and turn Apply
      // back on for a token that will be refused.
      this.post({
        type: 'previewStale',
        message: 'The changes moved while that was measuring. Preview them again.',
      });
      return;
    }

    this.previewToken = result.token;
    this.previewDestructive = result.destructive;
    this.previewSummary = result.summary;

    this.post({
      type: 'preview',
      findings: result.findings.map(serialiseFinding),
      summary: result.summary,
      destructive: result.destructive,
      blocking: result.blocking,
      canApply: true,
      // Which tables this lands on, so the diagram can say where rather than
      // leaving someone to find it among twenty-one cards.
      affected: affectedTables(result.findings),
    });
  }

  private async apply(confirmed: boolean): Promise<void> {
    const adapter = this.requireAdapter();

    if (!this.previewToken) {
      this.post({
        type: 'error',
        message: 'Preview these changes before applying them.',
      });
      return;
    }

    // Both are generated before anything runs, because both need the schema as
    // it is now: after the apply, the column's type and its contents are gone.
    const state = this.session.state();
    const down = await downMigration(
      this.requireAdapter(),
      state.changes.map((change) => change.edit),
    ).catch(() => undefined);

    let rescuePath: string | undefined;

    // A second confirmation, in the editor rather than the webview, for
    // anything that destroys data. The webview asked once; this is the one the
    // user cannot click through without reading.
    if (this.previewDestructive && confirmed) {
      // Written before the confirmation, not after it. A safety net offered
      // after the user has already committed to the change is a receipt.
      const rescue = await this.writeRescueFile();
      rescuePath = rescue?.path;

      const detail = rescue
        ? rescue.incomplete
          ? `The rows it removes have been saved to ${rescue.path}, but the capture ` +
            `hit its cap — that file is not a complete copy.`
          : `The ${rescue.rows.toLocaleString()} rows it removes have been saved to ` +
            `${rescue.path}, with the statements to put them back.`
        : 'Dry Run could not save a copy of the rows this removes.';

      const choice = await vscode.window.showWarningMessage(
        'These changes destroy data that cannot be recovered. Apply them?',
        { modal: true, detail },
        'Apply',
      );
      if (choice !== 'Apply') {
        this.post({ type: 'applyCancelled' });
        return;
      }
    }

    const result = await this.session.apply(adapter, {
      token: this.previewToken,
      destructive: this.previewDestructive,
      confirmedDestructive: confirmed,
    });

    // Recorded before the session is cleared, since the statements come from
    // it. A failure to record is not a failure to apply, and pretending
    // otherwise would be worse than a missing history entry.
    await this.host?.history
      ?.record({
        connection: this.connectionName,
        statements: state.changes.map((change) => change.sql),
        summary: this.previewSummary,
        rowCounts: result.rowCounts,
        ...(rescuePath ? { rescueFile: rescuePath } : {}),
        ...(down ? { downSql: down.sql } : {}),
      })
      .catch((error: unknown) => this.host?.report(error));

    this.session.clear();
    this.clearPreview();
    this.post({ type: 'applied', applied: result.applied });

    // The picture is now out of date in a way the projection cannot fix.
    await this.host?.refresh();
  }

  /**
   * Saves the rows the pending changes would destroy, as SQL that puts them
   * back.
   *
   * To a file on disk rather than an unsaved editor tab: the point of the file
   * is to survive the thing that goes wrong, and an unsaved buffer does not
   * survive very much. Failing to write it does not block the apply — the user
   * is told instead, and gets to decide, which is the same principle the rest
   * of the extension runs on.
   */
  private async writeRescueFile(): Promise<
    { path: string; rows: number; incomplete: boolean } | undefined
  > {
    try {
      const adapter = this.requireAdapter();
      const rescue = await captureRescue(
        adapter,
        this.session.state().changes.map((change) => change.edit),
      );
      if (rescue.sections.length === 0) {
        return undefined;
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const directory = folder
        ? vscode.Uri.joinPath(folder, '.dryrun')
        : vscode.Uri.file(os.tmpdir());
      const target = vscode.Uri.joinPath(directory, `rescue-${stamp}.sql`);

      await vscode.workspace.fs.createDirectory(directory);
      await vscode.workspace.fs.writeFile(target, Buffer.from(rescue.sql, 'utf8'));

      // Opened beside, so the user can read what is about to be lost while the
      // confirmation is still on screen.
      const document = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });

      return {
        path: vscode.workspace.asRelativePath(target),
        rows: rescue.totalRows,
        incomplete: rescue.incomplete,
      };
    } catch (error) {
      this.host?.report(error);
      return undefined;
    }
  }

  /**
   * The health of the schema, for the diagram overlays.
   *
   * Fetched only when an overlay that needs it is chosen. Two of the six —
   * rows and size — are already in the snapshot, and making every user pay
   * four catalogue queries on open for an overlay most never pick would be a
   * slower panel in exchange for nothing.
   */
  private async sendHealth(): Promise<void> {
    try {
      const health = await this.requireAdapter().schemaHealth();
      this.post({
        type: 'health',
        health: {
          statsSince: health.statsSince ? health.statsSince.toISOString() : null,
          unusedIndexes: health.unusedIndexes,
          redundantIndexes: health.redundantIndexes,
          unindexedForeignKeys: health.unindexedForeignKeys,
          tables: health.tables.map((table) => ({
            ...table,
            lastVacuum: table.lastVacuum ? table.lastVacuum.toISOString() : null,
            lastAnalyze: table.lastAnalyze ? table.lastAnalyze.toISOString() : null,
          })),
        },
      });
    } catch (error) {
      this.post({ type: 'healthFailed', message: errorMessage(error) });
    }
  }

/**
   * The migration that undoes the pending one.
   *
   * Generated now rather than later, because "later" is after the change has
   * been applied — and by then the schema no longer remembers the column's
   * type or its default. This is the whole reason down migrations are usually
   * wrong: they are written against the wrong version of the schema.
   */
  private async exportDown(): Promise<void> {
    if (!this.session.language.hasDownMigration) {
      // The button is hidden on this engine, so getting here means something
      // sent the message anyway. Say what is missing rather than falling
      // through to the SQL generator, which is what used to happen.
      this.post({
        type: 'error',
        message:
          'Dry Run cannot generate a down migration for MongoDB yet. Undoing a $rename or a ' +
          'createIndex is straightforward and undoing a $unset is not possible at all, and ' +
          'until it can say which is which for a whole changeset it will not offer one.',
      });
      return;
    }

    const state = this.session.state();
    if (state.changes.length === 0) {
      this.post({ type: 'error', message: 'There are no pending changes to reverse.' });
      return;
    }

    try {
      const down = await downMigration(
        this.requireAdapter(),
        state.changes.map((change) => change.edit),
      );

      const document = await vscode.workspace.openTextDocument({
        language: this.session.language.documentLanguage,
        content: down.sql,
      });
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
    } catch (error) {
      this.post({ type: 'error', message: errorMessage(error) });
    }
  }

  private async exportSql(): Promise<void> {
    const state = this.session.state();
    if (!state.sql.trim()) {
      this.post({
        type: 'error',
        message: 'There are no pending changes to export.',
      });
      return;
    }

    const dialect = this.session.language;
    const mark = dialect.comment;

    const document = await vscode.workspace.openTextDocument({
      language: dialect.documentLanguage,
      content:
        `${mark} Generated by Dry Run from ${state.changes.length} visual ` +
        `${state.changes.length === 1 ? 'change' : 'changes'}.\n` +
        `${mark} Review it, keep it, run it through your migration tool.\n\n${state.sql}\n`,
    });
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
    });
  }

  /**
   * The diagram as Mermaid, opened as a file.
   *
   * Mermaid rather than an image because GitHub renders it natively: the
   * diagram can live in a README and stay readable in a pull request and a
   * diff. A PNG stops being true the first time the schema changes and nobody
   * notices for a year.
   */
  private async exportDiagram(): Promise<void> {
    if (!this.baseline) {
      this.post({ type: 'error', message: 'The schema has not loaded yet.' });
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content:
        `# Database schema\n\n` +
        `<!-- Generated by Dry Run. ${this.baseline.tables.length} tables, ` +
        `${this.baseline.foreignKeys.length} relationships. -->\n\n` +
        '```mermaid\n' +
        `${toMermaid(this.baseline)}\n` +
        '```\n',
    });
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
    });
  }

  /**
   * How to get from one table to another.
   *
   * The foreign keys are already a graph, so the question every developer
   * answers by tracing a diagram with a finger can just be walked.
   */
  private findPath(from: string, to: string): void {
    if (!this.baseline) {
      return;
    }

    const path = findJoinPath(this.baseline, from, to);
    this.post({
      type: 'joinPath',
      from,
      to,
      found: Boolean(path),
      tables: path?.tables ?? [],
      joins: path?.steps.length ?? 0,
      // The route in the language this engine speaks. A SELECT handed to a
      // MongoDB user is a query that cannot run against the database they are
      // looking at.
      sql:
        (this.session.language.engine === 'mongo' ? path?.pipeline : path?.sql) ?? '',
    });
  }

  /**
   * Asks for a name and adds a table with a sensible starting shape.
   *
   * An id column by default, because a table without a primary key cannot be
   * edited row by row later — the drawer has nothing to write a WHERE against
   * — and discovering that after you have put data in it is a bad afternoon.
   */
  private async newTable(): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: 'New table',
      prompt: 'Name for the new table',
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return 'A table needs a name.';
        if (this.baseline?.tables.some((t) => t.qualified === trimmed || t.name === trimmed)) {
          return `There is already a table called ${trimmed}.`;
        }
        return undefined;
      },
    });

    if (!name?.trim()) {
      return;
    }

    this.session.add({
      kind: 'create_table',
      table: name.trim(),
      columns: [{ name: 'id', type: 'bigserial', nullable: false, primaryKey: true }],
    });
    this.clearPreview();
    this.postChangeset();
  }

  /**
   * Renames a table, asking first.
   *
   * `validateInput` rather than a silent no-op on a bad answer: a rename that
   * quietly does not happen is indistinguishable from a broken button, which is
   * what these all were.
   */
  private async renameTable(table: string): Promise<void> {
    const to = await vscode.window.showInputBox({
      title: `Rename ${table}`,
      prompt: 'New name for the table',
      value: table,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return 'A table needs a name.';
        if (trimmed === table) return 'That is the name it already has.';
        if (this.baseline?.tables.some((t) => t.qualified === trimmed || t.name === trimmed)) {
          return `There is already a table called ${trimmed}.`;
        }
        return undefined;
      },
    });

    if (!to?.trim() || to.trim() === table) {
      return;
    }

    this.addEdit({ kind: 'rename_table', table, to: to.trim() });
  }

  private async renameColumn(table: string, column: string): Promise<void> {
    const columns = this.baseline?.tables.find(
      (one) => one.qualified === table || one.name === table,
    )?.columns;

    const to = await vscode.window.showInputBox({
      title: `Rename ${column}`,
      prompt: `New name for this column in ${table}`,
      value: column,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return 'A column needs a name.';
        if (trimmed === column) return 'That is the name it already has.';
        if (columns?.some((one) => one.name === trimmed)) {
          return `${table} already has a column called ${trimmed}.`;
        }
        return undefined;
      },
    });

    if (!to?.trim() || to.trim() === column) {
      return;
    }

    this.addEdit({ kind: 'rename_column', table, column, to: to.trim() });
  }

  private async changeType(table: string, column: string, from: string): Promise<void> {
    const to = await vscode.window.showInputBox({
      title: `Change the type of ${column}`,
      prompt:
        'Every existing value has to convert. The preview counts the ones that cannot, ' +
        'before anything runs.',
      value: from,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return 'A column needs a type.';
        if (trimmed === from) return `That is the type it already has.`;
        return undefined;
      },
    });

    if (!to?.trim() || to.trim() === from) {
      return;
    }

    this.addEdit({ kind: 'alter_type', table, column, to: to.trim() });
  }

  /**
   * Drops a table, after the name has been typed out.
   *
   * Typing it is not ceremony. This is the most destructive thing the editor
   * can add to a changeset, and a button that does it on one press is a button
   * someone eventually hits by accident. `validateInput` means the OK button
   * stays disabled until the answer is exactly right, which is stronger than
   * checking afterwards.
   */
  private async dropTable(table: string, rows: number): Promise<void> {
    const typed = await vscode.window.showInputBox({
      title: `Drop ${table}`,
      prompt: `This drops ${table} and all ${rows.toLocaleString()} rows in it. Type the table name to confirm.`,
      placeHolder: table,
      validateInput: (value) =>
        value.trim() === table ? undefined : `Type ${table} exactly to confirm.`,
    });

    if (typed?.trim() !== table) {
      return;
    }

    this.addEdit({ kind: 'drop_table', table });
  }

  /**
   * Says that what you asked to be shown is not on screen.
   *
   * Silently doing nothing reads as a broken button, and the diagram is the one
   * place where "nothing happened" is also a plausible correct outcome.
   */
  private sayNotDrawn(tables: readonly string[]): void {
    void vscode.window.showWarningMessage(
      tables.length === 1
        ? `${tables[0]} is not currently drawn — the schema filter or focus mode is hiding it.`
        : 'Those tables are not currently drawn — the schema filter or focus mode is hiding them.',
    );
  }

  /** One edit, plus the two things that always follow it. */
  private addEdit(edit: Edit): void {
    this.session.add(edit);
    this.clearPreview();
    this.postChangeset();
  }

  private postChangeset(): void {
    const state = this.session.state();
    this.post({
      type: 'changeset',
      changes: state.changes.map((change) => ({
        index: change.index,
        label: change.label,
        sql: change.sql,
      })),
      diff: state.diff,
      projected: state.projected,
      sql: state.sql,
      // What this engine calls things. "Export SQL" on a MongoDB connection was
      // a small lie that gave away a large one — the file behind it really was
      // SQL — so the words travel with the changeset rather than being baked
      // into the markup.
      dialect: {
        noun: this.session.language.noun,
        exportLabel: this.session.language.exportLabel,
        downLabel: this.session.language.downLabel,
        hasNullability: this.session.language.hasNullability,
        hasDownMigration: this.session.language.hasDownMigration,
      },
    });
  }

  private clearPreview(): void {
    this.previewToken = undefined;
    this.previewDestructive = false;
    this.previewSummary = '';
    // Anything in flight is now describing something that is not there.
    this.generation += 1;
  }

  private requireAdapter(): DatabaseAdapter {
    const adapter = this.host?.adapter();
    if (!adapter) {
      throw new Error('Not connected to a database.');
    }
    return adapter;
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private render(): string {
    return schemaPanelHtml(htmlOptionsFor(this.panel.webview, this.context.extensionUri));
  }

  private dispose(): void {
    SchemaPanel.current = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

/**
 * Kept as a name because it is used everywhere; the work moved to errors.ts
 * after an AggregateError with an empty message rendered as an empty red box.
 */
function errorMessage(error: unknown): string {
  return describeError(error);
}

/** Postgres values become display strings before crossing into the webview. */
function serialiseDetail(detail: {
  filter?: string;
  matched?: number;
  table: string;
  columns: readonly unknown[];
  indexes: readonly unknown[];
  constraints: readonly unknown[];
  primaryKey: readonly string[];
  rows: number;
  rowsEstimated: boolean;
  sample: readonly Record<string, unknown>[];
}): unknown {
  return {
    ...detail,
    sample: detail.sample.map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, formatValue(value)])),
    ),
    // The raw values are kept alongside the display ones, because editing a row
    // needs the real key, not its rendering.
    sampleRaw: detail.sample.map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toJsonSafe(value)])),
    ),
  };
}

function serialiseFinding(finding: unknown): unknown {
  return JSON.parse(JSON.stringify(finding, (_key, value) => toJsonSafe(value)));
}

function toJsonSafe(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return `<${value.length} bytes>`;
  }
  return value;
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '∅';
  }
  if (value instanceof Date) {
    return value
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '');
  }
  if (Buffer.isBuffer(value)) {
    return `<${value.length} bytes>`;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}


/**
 * Which tables a set of findings lands on, and how badly.
 *
 * "Preview" used to answer in a sentence at the bottom of the screen. Zoomed
 * out over twenty-one cards, a sentence does not tell you where anything is
 * about to happen — so the answer goes on the diagram as well, and the worst
 * thing happening to a table is what colours it.
 */
export function affectedTables(
  findings: readonly { severity: Severity; classification: { table?: string } }[],
): Record<string, Severity> {
  const rank: Record<Severity, number> = {
    safe: 0,
    caution: 1,
    blocking: 2,
    destructive: 3,
  };

  const worst: Record<string, Severity> = {};
  for (const finding of findings) {
    const table = finding.classification.table;
    if (!table) {
      continue;
    }
    const current = worst[table];
    if (current === undefined || (rank[finding.severity] ?? 0) > (rank[current] ?? 0)) {
      worst[table] = finding.severity;
    }
  }
  return worst;
}
