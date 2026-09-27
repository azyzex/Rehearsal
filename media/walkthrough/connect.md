# Point it at your own database

Paste a connection string into the Rehearsal panel in the activity bar. It works out the engine from the string: Postgres, MySQL, MongoDB and SQLite.

Connections you keep go in the OS keychain. Only their names are written to disk.

Use staging or a copy of production rather than production itself. Rehearsal refuses anything that looks like production unless you allow it by name.
