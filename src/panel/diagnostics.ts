import * as vscode from 'vscode';
import { Engine } from '../adapters/types';
import { Finding, Severity } from '../analysis/types';
import { SplitStatement } from '../parser/splitter';

/**
 * The findings, as things the editor already knows how to show.
 *
 * The panel is the product, but the panel is also a thing you have to be
 * looking at. A diagnostic goes in the Problems view, in the file's ruler, in
 * the tab's error count, and in whatever the person has bound to "next
 * problem" — none of which needed building, and all of which the reader
 * already checks out of habit.
 *
 * They are cleared when the file changes, because a measurement describes the
 * statement that produced it. Leaving a squiggle on an edited line would be
 * asserting something about SQL nobody has measured.
 */

const SEVERITY: Record<Severity, vscode.DiagnosticSeverity> = {
  safe: vscode.DiagnosticSeverity.Hint,
  caution: vscode.DiagnosticSeverity.Information,
  blocking: vscode.DiagnosticSeverity.Warning,
  destructive: vscode.DiagnosticSeverity.Warning,
};

/** One measured statement, located in the document it was measured from. */
export interface MeasuredStatement {
  readonly finding: Finding;
  readonly engine: Engine;
  /** Character offsets into the document, not into the analysed slice. */
  readonly start: number;
  readonly end: number;
}

export class FindingDiagnostics {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly disposables: vscode.Disposable[] = [];
  private uri: vscode.Uri | undefined;
  private statements: readonly SplitStatement[] = [];
  private readonly findings = new Map<number, Finding>();
  private engine: Engine = 'postgres';
  /**
   * Where in the document the analysed text began.
   *
   * Zero for a whole file, and the start of the selection when someone
   * previewed part of one — statement offsets are relative to the text that
   * was split, and a quick fix that edits the file needs the real position.
   */
  private offset = 0;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection('dryrun');
    this.disposables.push(
      this.collection,
      // A measurement describes the statement that produced it, and an edited
      // file no longer contains that statement.
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.uri && event.document.uri.toString() === this.uri.toString()) {
          this.clear();
        }
      }),
    );
  }

  /** Starts a fresh run over `document`, discarding anything from the last one. */
  begin(
    document: vscode.TextDocument,
    statements: readonly SplitStatement[],
    engine: Engine = 'postgres',
    offset = 0,
  ): void {
    this.clear();
    this.uri = document.uri;
    this.statements = statements;
    this.engine = engine;
    this.offset = offset;
  }

  /**
   * The measurement covering a line, for whoever wants to act on it.
   *
   * This is what the quick fixes are built from. They live off the same run
   * the squiggle came from rather than re-deriving anything, so an offer can
   * never describe a statement that was not the one measured.
   */
  measuredAt(uri: vscode.Uri, line: number): MeasuredStatement | undefined {
    if (!this.uri || uri.toString() !== this.uri.toString()) {
      return undefined;
    }

    for (const finding of this.findings.values()) {
      const statement = this.statements[finding.statementIndex];
      if (statement && line >= statement.startLine && line <= statement.endLine) {
        return {
          finding,
          engine: this.engine,
          start: this.offset + statement.startOffset,
          end: this.offset + statement.endOffset,
        };
      }
    }

    return undefined;
  }

  add(finding: Finding): void {
    if (!this.uri) {
      return;
    }
    this.findings.set(finding.statementIndex, finding);
    this.publish();
  }

  clear(): void {
    this.findings.clear();
    this.collection.clear();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private publish(): void {
    if (!this.uri) {
      return;
    }

    const diagnostics: vscode.Diagnostic[] = [];
    for (const finding of this.findings.values()) {
      // Nothing is drawn for a statement that changes nothing. A file of
      // twenty safe statements would otherwise put twenty hints in the
      // Problems view and teach the reader to collapse the whole section.
      if (finding.severity === 'safe' && !finding.error) {
        continue;
      }

      const statement = this.statements[finding.statementIndex];
      if (!statement) {
        continue;
      }

      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(statement.startLine, 0, statement.startLine, Number.MAX_SAFE_INTEGER),
        `${finding.headline}: ${finding.detail}`,
        SEVERITY[finding.severity],
      );

      diagnostic.source = 'Dry Run';
      // The code shows in the Problems view next to the message, and it is the
      // one word that says how seriously to take the rest of the line.
      diagnostic.code = finding.severity;

      const tags = relatedInformation(finding, this.uri, statement);
      if (tags.length > 0) {
        diagnostic.relatedInformation = tags;
      }

      diagnostics.push(diagnostic);
    }

    this.collection.set(this.uri, diagnostics);
  }
}

/**
 * The context that belongs with the finding rather than in it.
 *
 * The message is one line and has to stay readable at the width of the
 * Problems view. What a delete cascades to, and what is queued in front of it,
 * go here — visible on the row, without making the row unreadable.
 */
function relatedInformation(
  finding: Finding,
  uri: vscode.Uri,
  statement: SplitStatement,
): vscode.DiagnosticRelatedInformation[] {
  const at = new vscode.Location(uri, new vscode.Position(statement.startLine, 0));
  const related: vscode.DiagnosticRelatedInformation[] = [];

  if (finding.queuedBehind && finding.queuedBehind.length > 0) {
    const count = finding.queuedBehind.length;
    related.push(
      new vscode.DiagnosticRelatedInformation(
        at,
        `Would wait for ${count} running ${count === 1 ? 'session' : 'sessions'}, and ` +
          `everything arriving after it would wait too.`,
      ),
    );
  }

  if (finding.cascade && finding.cascade.children.length > 0) {
    const total = countCascade(finding.cascade);
    if (total > 0) {
      related.push(
        new vscode.DiagnosticRelatedInformation(
          at,
          `Cascades to ${total.toLocaleString()} rows in other tables.`,
        ),
      );
    }
  }

  const escaping = (finding.triggers ?? []).filter((trigger) => trigger.escapes.length > 0);
  for (const trigger of escaping) {
    related.push(
      new vscode.DiagnosticRelatedInformation(
        at,
        `Trigger ${trigger.name} ${trigger.escapes.join('; ')} — a rollback does not take that back.`,
      ),
    );
  }

  return related;
}

/** Rows a cascade would remove from tables other than the one named. */
function countCascade(node: Finding['cascade']): number {
  if (!node) {
    return 0;
  }
  return node.children.reduce(
    (sum, child) => sum + child.rows + countCascade(child),
    0,
  );
}
