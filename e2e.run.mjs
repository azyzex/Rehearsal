import { createDB } from 'mysql-memory-server';
import { execFileSync } from 'node:child_process';

const db = await createDB({ username: 'root', logLevel: 'ERROR' });
const url = `mysql://${db.username}@127.0.0.1:${db.port}/${db.dbName}`;
const run = (args) => {
  try { return execFileSync(process.execPath, args, { encoding: 'utf8' }); }
  catch (e) { return `exit ${e.status}\n${e.stdout || ''}${e.stderr || ''}`; }
};
run(['testbed/mysql-blog/scripts/setup.mjs', '--url', url,
     '--authors', '2000', '--posts', '6000', '--comments', '20000']);
console.log(run(['dist/cli.js', 'testbed/mysql-blog/migrations/0001_cleanup.sql', '--url', url]));
await db.stop();
