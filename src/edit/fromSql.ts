import { Classification } from '../parser/classifier';
import { Edit } from './changeset';

/**
 * A parsed migration statement, expressed as the edit it performs.
 *
 * This is what lets a hand-written migration file get the same before/after
 * treatment as a change made by clicking: both become edits, both go through
 * the same projection, both are drawn by the same renderer. Without it the
 * file preview and the visual editor would be two implementations of "what
 * will this look like afterwards" that could disagree, and the one that was
 * wrong would be whichever was used less.
 *
 * Returns undefined for anything that does not change the shape the diagram
 * draws — row edits, index builds, statements the classifier did not
 * recognise. Those still appear in the preview with their measured
 * consequences; they simply do not move the picture.
 */
export function editFromClassification(classification: Classification): Edit | undefined {
  const { table, column } = classification;
  if (!table) {
    return undefined;
  }

  switch (classification.kind) {
    case 'drop_column':
      return column ? { kind: 'drop_column', table, column } : undefined;

    case 'add_column':
      return column
        ? {
            kind: 'add_column',
            table,
            column,
            // The declared type is not extracted by the classifier for ADD
            // COLUMN, and inventing one would put a wrong type on the diagram.
            type: 'unknown',
            nullable: true,
          }
        : undefined;

    case 'rename_column':
      // The classifier keeps the old name; the new one is not extracted, so
      // the projection would rename it to nothing. Better to leave the picture
      // alone than to move it wrongly.
      return undefined;

    case 'alter_column_type':
      return column && classification.newType
        ? { kind: 'alter_type', table, column, to: classification.newType }
        : undefined;

    case 'set_not_null':
      return column ? { kind: 'set_nullability', table, column, nullable: false } : undefined;

    case 'drop_not_null':
      return column ? { kind: 'set_nullability', table, column, nullable: true } : undefined;

    case 'add_foreign_key': {
      const reference = classification.references;
      return reference && classification.columns?.length
        ? {
            kind: 'add_foreign_key',
            table,
            columns: [...classification.columns],
            referencedTable: reference.table,
            referencedColumns: [...reference.columns],
          }
        : undefined;
    }

    case 'drop_table':
      return { kind: 'drop_table', table };

    case 'rename_table':
      // Same reason as rename_column: the target name is not extracted.
      return undefined;

    default:
      return undefined;
  }
}

/** Every statement in a file that moves the diagram, in file order. */
export function editsFromClassifications(
  classifications: readonly Classification[],
): { readonly edits: Edit[]; readonly indexes: number[] } {
  const edits: Edit[] = [];
  const indexes: number[] = [];

  classifications.forEach((classification, index) => {
    const edit = editFromClassification(classification);
    if (edit) {
      edits.push(edit);
      indexes.push(index);
    }
  });

  return { edits, indexes };
}
