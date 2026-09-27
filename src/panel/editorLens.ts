import * as vscode from 'vscode';
import { Engine, SchemaSnapshot } from '../adapters/types';
import { formatCount } from '../analysis/severity';
import { languageFor } from '../parser/language';
import { FindingDiagnostics } from './diagnostics';

/**
 * The answer where the eye already is.
 *
 * The panel is the product, but it is a thing beside the file. These put the
 * two things people glance for into the file itself: above each statement,
 * what it will do (or a link to find out); over each table name, how big the
 * table is and what is in it.
 *
 * Neither ever opens a connection. They read the one that is already open, and
 * say nothing when there is none — a hover that connects to a database is the
 * kind of surprise this whole extension exists to avoid.
 */

// ---- CodeLens ----------------------------------------------------------------

export class StatementLenses implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(
    private readonly diagnostics: FindingDiagnostics,
    private readonly engine: () => Engine | undefined,
  ) {
    // A measurement arriving, or being cleared by an edit, changes what goes
    // above the statement.
    diagnostics.onChanged(() => this.changed.fire());
  }

  refresh(): void {
    this.changed.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('rehearsal').get<boolean>('codeLens', true)) {
      return [];
    }

    // SQL files are split as SQL whatever is connected; a MongoDB connection
    // does not make a .sql file a list of operations.
    const connected = this.engine();
    const engine: Engine =
      document.languageId === 'sql'
        ? connected && connected !== 'mongo'
          ? connected
          : 'postgres'
        : 'mongo';
    let statements;
    try {
      statements = languageFor(engine).split(document.getText());
    } catch {
      return [];
    }

    // Past a few hundred statements the lenses stop being a summary and start
    // being furniture, and splitting on every keystroke starts to cost.
    if (statements.length === 0 || statements.length > 300) {
      return [];
    }

    return statements.map((statement) => {
      const range = new vscode.Range(statement.startLine, 0, statement.startLine, 0);
      const measured = this.diagnostics.measuredAt(document.uri, statement.startLine);

      if (measured) {
        return new vscode.CodeLens(range, {
          title: lensTitle(measured.finding),
          tooltip: measured.finding.detail,
          command: 'rehearsal.preview',
        });
      }

      return new vscode.CodeLens(range, {
        title: '$(play) Preview this statement',
        tooltip: 'Run it against the connected database, inside a transaction that is rolled back',
        command: 'rehearsal.previewStatement',
        arguments: [document.uri, statement.startOffset, statement.endOffset],
      });
    });
  }
}

/** The verdict in a line: what it is, and the number that makes it so. */
function lensTitle(finding: {
  severity: string;
  headline: string;
  rowCount?: number;
  lock?: { level: string };
}): string {
  const icon =
    finding.severity === 'destructive'
      ? '$(error)'
      : finding.severity === 'blocking'
        ? '$(warning)'
        : finding.severity === 'caution'
          ? '$(info)'
          : '$(pass)';

  const parts = [`${icon} ${finding.headline}`];
  if (typeof finding.rowCount === 'number' && finding.rowCount > 0) {
    parts.push(`${formatCount(finding.rowCount)} ${finding.rowCount === 1 ? 'row' : 'rows'}`);
  }
  if (finding.lock && finding.lock.level !== 'NONE') {
    parts.push(finding.lock.level);
  }
  return parts.join(' — ');
}

// ---- Hover -----------------------------------------------------------------------

export class TableHover implements vscode.HoverProvider {
  constructor(private readonly schema: () => Promise<SchemaSnapshot | undefined>) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_$.]*/);
    if (!range) {
      return undefined;
    }

    const word = document.getText(range).replace(/"/g, '').toLowerCase();
    const snapshot = await this.schema();
    if (!snapshot) {
      return undefined;
    }

    const table = snapshot.tables.find(
      (candidate) =>
        candidate.qualified.toLowerCase() === word || candidate.name.toLowerCase() === word,
    );
    if (!table) {
      return undefined;
    }

    const lines = [
      `**${table.qualified}** — about ${formatCount(table.rows)} rows, ${formatBytes(table.bytes)}`,
      '',
    ];

    const shown = table.columns.slice(0, 12);
    for (const column of shown) {
      const flags = [column.isPrimaryKey ? 'primary key' : '', column.nullable ? '' : 'not null']
        .filter(Boolean)
        .join(', ');
      lines.push(`- \`${column.name}\` ${column.type}${flags ? ` — ${flags}` : ''}`);
    }
    if (table.columns.length > shown.length) {
      lines.push(`- …and ${table.columns.length - shown.length} more`);
    }

    const keys = snapshot.foreignKeys.filter(
      (key) => key.fromTable === table.qualified || key.toTable === table.qualified,
    );
    if (keys.length > 0) {
      lines.push('', `Related: ${[...new Set(keys.map((key) =>
        key.fromTable === table.qualified ? key.toTable : key.fromTable,
      ))].join(', ')}`);
    }

    return new vscode.Hover(new vscode.MarkdownString(lines.join('\n')), range);
  }
}

function formatBytes(bytes: number): string {
  if (!bytes) {
    return 'size unknown';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
