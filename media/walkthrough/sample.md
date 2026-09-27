# See it work first

Rehearsal runs a migration against real data, inside a transaction that is rolled back, and tells you what it would have done.

The quickest way to see that is on a database built for it: a small SQLite file in the extension's own storage, with a sample migration beside it. No server, no credentials, nothing changed on your machine outside that folder.

Every number you will see is counted, not estimated.
