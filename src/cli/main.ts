import { run } from './index';

/**
 * The process entry point, kept separate from `run` so the whole CLI can be
 * driven from a test without exiting the test runner.
 */
void run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
