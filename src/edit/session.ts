import { DatabaseAdapter, SchemaSnapshot } from '../adapters/types';
import { analyzeStatements } from '../analysis/orchestrator';
import { Finding, Thresholds } from '../analysis/types';
import { SplitStatement } from '../parser/splitter';
import { ApplyResult, applyChangeset, previewTokenFor } from './apply';
import { Changeset, Edit, GeneratedStatement, describeEdit } from './changeset';
import { SchemaDiff, diffSchemas, projectSchema } from './project';

/**
 * One editing session: the pending changes, what they will do, and applying them.
 *
 * The three questions a visual editor has to answer, kept separate because they
 * have different answers:
 *
 *   - What am I asking for?      the changeset, and the SQL it becomes
 *   - What will it look like?    the projection — pure, instant, structural
 *   - What will it cost?         the preview — real execution, rolled back
 *
 * The projection updates on every edit because it is free. The preview costs
 * round trips and locks, so it runs when asked. Conflating the two would either
 * make every click slow or make the cost invisible, and the second is how you
 * end up with a tool that lets people drop a populated column by accident.
 */

export interface PendingChange {
  readonly index: number;
  readonly label: string;
  readonly sql: string;
  readonly edit: Edit;
}

export interface ChangesetState {
  readonly changes: readonly PendingChange[];
  readonly diff: SchemaDiff;
  /** The schema as it would be afterwards, for the "after" diagram. */
  readonly projected: SchemaSnapshot;
  /** The whole changeset as a migration file. */
  readonly sql: string;
}

export interface PreviewResult {
  /** Each carries `editIndex`, so the panel can pair it with the right change. */
  readonly findings: readonly (Finding & { editIndex: number })[];
  /** Proof that these exact statements were measured, required to apply. */
  readonly token: string;
  readonly destructive: boolean;
  readonly blocking: boolean;
  readonly summary: string;
}

export class EditSession {
  private readonly changeset = new Changeset();
  private baseline: SchemaSnapshot | undefined;

  /** The schema as it is now. Everything is projected forward from this. */
  setBaseline(snapshot: SchemaSnapshot): void {
    this.baseline = snapshot;
  }

  get isEmpty(): boolean {
    return this.changeset.isEmpty;
  }

  add(edit: Edit): void {
    this.changeset.add(edit);
  }

  removeAt(index: number): void {
    this.changeset.removeAt(index);
  }

  clear(): void {
    this.changeset.clear();
  }

  statements(): GeneratedStatement[] {
    return this.changeset.statements();
  }

  /**
   * Where things stand: the pending list, the projected schema, and the diff.
   *
   * Recomputed from scratch on every change rather than maintained
   * incrementally. It is a handful of array operations over a schema that is
   * already in memory, and an incremental version would be a second
   * implementation of the projection that could disagree with the first.
   */
  state(): ChangesetState {
    const edits = this.changeset.list();
    const baseline = this.baseline ?? { tables: [], foreignKeys: [], schemas: [] };
    const projected = projectSchema(baseline, edits);

    return {
      changes: edits.map((edit, index) => ({
        index,
        edit,
        label: describeEdit(edit),
        sql: this.changeset.statements()[index]?.sql ?? '',
      })),
      diff: diffSchemas(baseline, projected, edits),
      projected,
      sql: this.changeset.toSql(),
    };
  }

  /**
   * Runs the pending changes through the ordinary preview: really executed
   * against the real data, measured, rolled back.
   *
   * This is the same pipeline a hand-written migration file goes through. The
   * visual editor gets no shortcut and no special case, which is the only way
   * to be sure the two agree.
   */
  async preview(
    adapter: DatabaseAdapter,
    thresholds: Thresholds,
    onFinding?: (finding: Finding) => void,
  ): Promise<PreviewResult> {
    const generated = this.changeset.statements();
    const findings: Finding[] = [];

    await analyzeStatements({
      adapter,
      thresholds,
      statements: generated.map(toSplitStatement),
      onFinding: (finding) => {
        findings.push(finding);
        onFinding?.(finding);
      },
    });

    // Findings are numbered by their position among the generated statements,
    // and the panel lists edits. Those agree only while every edit produces
    // exactly one statement — which is true today and is not a property
    // anything enforces. Pairing on the edit itself removes the coincidence.
    const paired = findings.map((finding) => ({
      ...finding,
      editIndex: generated[finding.statementIndex]?.editIndex ?? finding.statementIndex,
    }));

    const destructive = findings.some((f) => f.severity === 'destructive');
    const blocking = findings.some((f) => f.severity === 'blocking');

    return {
      findings: paired,
      destructive,
      blocking,
      token: previewTokenFor(generated),
      summary: summarise(findings),
    };
  }

  /** Applies the changeset for real. Refuses anything not previewed as-is. */
  async apply(
    adapter: DatabaseAdapter,
    options: { token: string; destructive: boolean; confirmedDestructive: boolean },
  ): Promise<ApplyResult> {
    return applyChangeset(adapter, {
      statements: this.changeset.statements(),
      previewToken: options.token,
      isDestructive: options.destructive,
      confirmedDestructive: options.confirmedDestructive,
    });
  }
}

/**
 * A generated statement dressed as a file statement.
 *
 * The analysis pipeline reports findings against line numbers so the panel can
 * jump to them. There is no file here, so each change occupies its own line
 * index — enough for the findings to pair up with the pending list.
 */
function toSplitStatement(statement: GeneratedStatement, index: number): SplitStatement {
  return {
    index,
    sql: statement.sql,
    params: statement.params,
    startOffset: 0,
    endOffset: statement.sql.length,
    startLine: index,
    endLine: index,
  };
}

function summarise(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return 'Nothing to preview.';
  }

  const destructive = findings.filter((f) => f.severity === 'destructive').length;
  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  const total = findings.length;
  const changes = `${total} ${total === 1 ? 'change' : 'changes'}`;

  if (destructive === 0 && blocking === 0) {
    return `${changes}, nothing destructive found.`;
  }

  const parts: string[] = [];
  if (destructive > 0) {
    parts.push(`${destructive} would destroy data`);
  }
  if (blocking > 0) {
    parts.push(`${blocking} would fail`);
  }
  return `${parts.join(', ')}, out of ${changes}.`;
}
