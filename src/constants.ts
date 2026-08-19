/**
 * Reported to Postgres as `application_name`, so a DBA looking at
 * `pg_stat_activity` can identify — and kill — sessions opened by this
 * extension without having to guess (spec §10.5).
 */
export const APPLICATION_NAME = 'vscode-dryrun';
