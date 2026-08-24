import { SchemaSnapshot } from '../adapters/types';

/**
 * The schema as a Mermaid ER diagram.
 *
 * Mermaid rather than an image: GitHub renders it natively, so the diagram can
 * live in a README and stay readable in a pull request, in a diff, and in a
 * terminal. A PNG is a dead end the moment the schema changes.
 *
 * Deliberately not a migration tool's output. This describes what is there,
 * for a human reading a repository, and makes no attempt to be re-runnable.
 */
export function toMermaid(snapshot: SchemaSnapshot, options: { columns: boolean } = { columns: true }): string {
  const lines: string[] = ['erDiagram'];

  for (const table of snapshot.tables) {
    const name = mermaidName(table.qualified);

    if (!options.columns) {
      lines.push(`  ${name} {`, '  }');
      continue;
    }

    lines.push(`  ${name} {`);
    for (const column of table.columns) {
      // Mermaid's attribute grammar is `type name "comment"`, and it is fussy
      // about both, so the type is reduced to something it will accept.
      const key = column.isPrimaryKey ? ' PK' : '';
      lines.push(`    ${mermaidType(column.type)} ${mermaidName(column.name)}${key}`);
    }
    lines.push('  }');
  }

  const known = new Set(snapshot.tables.map((t) => t.qualified));
  for (const fk of snapshot.foreignKeys) {
    if (!known.has(fk.fromTable) || !known.has(fk.toTable)) {
      continue;
    }
    // Many-to-one: several rows on the referencing side point at one row on the
    // referenced side, which is what a foreign key is.
    lines.push(
      `  ${mermaidName(fk.toTable)} ||--o{ ${mermaidName(fk.fromTable)} : "${fk.fromColumns.join(', ')}"`,
    );
  }

  return lines.join('\n');
}

/** Mermaid identifiers allow only word characters and dashes. */
function mermaidName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

function mermaidType(type: string): string {
  return type
    .replace(/\(.*\)/, '')
    .replace(/\[\]/g, '_array')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+$/, '')
    .slice(0, 40) || 'unknown';
}
