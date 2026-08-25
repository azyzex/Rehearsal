import * as os from 'node:os';
import * as vscode from 'vscode';
import { DatabaseAdapter, SchemaSnapshot } from '../adapters/types';
import { Thresholds } from '../analysis/types';
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
    this.session.setBaseline(snapshot);
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

    const result = await this.session.preview(adapter, this.host!.thresholds());
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
        language: 'sql',
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

    const document = await vscode.workspace.openTextDocument({
      language: 'sql',
      content:
        `-- Generated by Dry Run from ${state.changes.length} visual ` +
        `${state.changes.length === 1 ? 'change' : 'changes'}.\n` +
        `-- Review it, keep it, run it through your migration tool.\n\n${state.sql}\n`,
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
      sql: path?.sql ?? '',
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
    });
  }

  private clearPreview(): void {
    this.previewToken = undefined;
    this.previewDestructive = false;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
