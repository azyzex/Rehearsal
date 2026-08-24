import * as vscode from 'vscode';
import { DatabaseAdapter, SchemaSnapshot } from '../adapters/types';
import { Thresholds } from '../analysis/types';
import { Edit } from '../edit/changeset';
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
}

export class SchemaPanel {
  private static current: SchemaPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly session = new EditSession();
  private host: SchemaHost | undefined;
  private previewToken: string | undefined;
  private previewDestructive = false;
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
      changes: options.labels.map((label, index) => ({ index, label, sql: '' })),
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

        case 'exportDiagram':
          await this.exportDiagram();
          break;

        case 'newTable':
          await this.newTable();
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
    const adapter = this.requireAdapter();
    this.post({ type: 'tableLoading', table });
    const detail = await adapter.tableDetail(table, 25, filter);
    this.post({ type: 'tableDetail', detail: serialiseDetail(detail) });
  }

  private async preview(): Promise<void> {
    const adapter = this.requireAdapter();
    if (this.session.isEmpty) {
      this.post({ type: 'error', message: 'There are no pending changes to preview.' });
      return;
    }

    this.post({ type: 'previewStarted' });

    const result = await this.session.preview(adapter, this.host!.thresholds());
    this.previewToken = result.token;
    this.previewDestructive = result.destructive;

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

    // A second confirmation, in the editor rather than the webview, for
    // anything that destroys data. The webview asked once; this is the one the
    // user cannot click through without reading.
    if (this.previewDestructive && confirmed) {
      const choice = await vscode.window.showWarningMessage(
        'These changes destroy data that cannot be recovered. Apply them?',
        { modal: true },
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

    this.session.clear();
    this.clearPreview();
    this.post({ type: 'applied', applied: result.applied });

    // The picture is now out of date in a way the projection cannot fix.
    await this.host?.refresh();
  }

  private async exportSql(): Promise<void> {
    const state = this.session.state();
    if (!state.sql.trim()) {
      this.post({ type: 'error', message: 'There are no pending changes to export.' });
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'sql',
      content:
        `-- Generated by Dry Run from ${state.changes.length} visual ` +
        `${state.changes.length === 1 ? 'change' : 'changes'}.\n` +
        `-- Review it, keep it, run it through your migration tool.\n\n${state.sql}\n`,
    });
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
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
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
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
    const webview = this.panel.webview;
    const media = (file: string): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));

    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
        Math.floor(Math.random() * 62),
      ),
    ).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${media('schema.css')}" rel="stylesheet">
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
    <button id="discard" type="button">Discard</button>
    <button id="preview" type="button" class="primary">Preview</button>
    <button id="apply" type="button" class="danger" hidden>Apply</button>
  </header>
  <div id="changes-body"></div>
</section>

<footer id="legend">
  <span><i class="swatch pk"></i> primary key</span>
  <span><i class="swatch fk"></i> foreign key</span>
  <span>Drag to move · scroll to zoom · click a table to open it</span>
  <span id="connection"></span>
</footer>

<script nonce="${nonce}" src="${media('schema.js')}"></script>
<script nonce="${nonce}" src="${media('schema-editor.js')}"></script>
</body>
</html>`;
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
    return value.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  }
  if (Buffer.isBuffer(value)) {
    return `<${value.length} bytes>`;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}
