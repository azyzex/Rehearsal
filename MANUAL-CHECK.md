# The pass only you can do

The browser harness renders the real markup, stylesheet and scripts, and drives
them with real clicks. It cannot see four things:

1. **Whether the extension actually sends those messages.** The harness posts
   them by hand. If a command never posts one, every UI test still passes.
2. **A real theme.** The harness uses stand-ins for Dark+ and has never rendered
   a light theme at all.
3. **The extension host.** Command registration, keybindings, activation errors,
   the Problems view, the modal dialogs.
4. **A real database round trip through the UI.**

So this is a list of exactly what to press. It is ordered by how likely each
one is to be broken, not by how the extension is organised.

---

## Setting up (once)

1. Open this folder in VS Code.
2. Press `f5`. A second VS Code window opens, titled **[Extension Development
   Host]**. Everything below happens in **that** window.
3. In the new window: `ctrl + k` then `ctrl + o`, and open
   `testbed/postgres-shop`. It must be the folder, not a file.
4. `ctrl + shift + p` → type `Dry Run: Test Connection` → enter.
   You should get a notification naming the database. If you get "no connection
   string", use the **Select .env file…** button on the error and pick
   `testbed/postgres-shop/.env`.

If the window opens with no folder, or you get an apc-extension error, close it
and press `f5` again from the first window.

---

## The ten minutes that matter most

These are the newest and least verified. Tick as you go.

### 1. The offending rows — never seen end to end

- [ ] Open `migrations/0003_email_not_null.sql`.
- [ ] `ctrl + alt + d`.
- [ ] The row should say something like *"12 rows have no email"*.
- [ ] Click **Show me which rows**.
- [ ] **Expect:** a table of actual rows appears, with the `email` column
      highlighted, and a suggested fix underneath with **Copy** and
      **Insert above the statement** buttons.
- [ ] **The thing to catch:** the button does nothing, or spins forever. That
      means the extension never answered.
- [ ] Click **Insert above the statement**. The SQL file should gain a new line
      above the statement. Press `ctrl + z` to undo it.

### 2. Where the code uses it — same risk

- [ ] Open `migrations/0002_drop_phone_number.sql`, `ctrl + alt + d`.
- [ ] Click **Where does the code use this?**.
- [ ] **Expect:** a list of `file:line` with matching lines, or a sentence
      saying nothing was found in N files.
- [ ] **The thing to catch:** it hangs, or reports 0 files searched.

### 3. Would an index help — a whole new panel

- [ ] Open any `.sql` file and type this on its own line:
      `SELECT id FROM orders WHERE user_id = 4242 AND status = 'paid';`
- [ ] Put the cursor inside that line.
- [ ] `ctrl + alt + i`.
- [ ] **Expect:** a new panel titled **Dry Run — Indexes** with a card, a green
      **Used** badge, and two bars — a long one for *Now* and a very short one
      for *With the index*.
- [ ] **The thing to catch:** an empty panel, or "no sequential scan found".
- [ ] The buttons at the bottom should look like buttons, not like plain text.

### 4. Schema health and the diagram overlays

- [ ] `ctrl + shift + p` → `Dry Run: Schema Health Report`.
- [ ] **Expect:** a markdown document opens listing unindexed foreign keys with
      `CREATE INDEX CONCURRENTLY` statements.
- [ ] `ctrl + shift + p` → `Dry Run: Explore Schema`.
- [ ] In the toolbar, the dropdown that says **No overlay** → pick
      **Colour by rows**.
- [ ] **Expect:** cards take on an orange tint, darkest for the biggest table,
      and a line appears at the bottom naming the largest one.
- [ ] Now pick **Foreign keys with no index**. It should say "Reading the
      statistics…" briefly, then shade only some tables.
- [ ] **The thing to catch:** it sits on "Reading the statistics…" forever.

### 5. The Problems view

- [ ] With a preview still open, press `ctrl + shift + m`.
- [ ] **Expect:** one entry per risky statement, source **Dry Run**, and
      clicking one jumps to the line.
- [ ] Type a character into the SQL file. **Expect:** the entries disappear.

### 6. Pending migrations

- [ ] `ctrl + shift + p` → `Dry Run: Preview Pending Migrations`.
- [ ] **Expect:** a picker listing the migration files, with a note that they
      are plain SQL and it cannot tell which have been applied.
- [ ] Pick one. It should open the file and preview it.

---

## The rest, when you have time

### Applying, the rescue file and the down migration

Do this one on a table you do not mind changing.

- [ ] `Dry Run: Explore Schema`, click a table, and use **Drop** on a column.
- [ ] Click **Down SQL**. **Expect:** a SQL document with a header listing what
      it cannot undo.
- [ ] Click **Preview**, then **Apply**.
- [ ] **Expect:** a `.dryrun/rescue-<timestamp>.sql` file opens *before* the
      confirmation dialog, and the dialog itself mentions how many rows were
      saved.
- [ ] Cancel the dialog. Nothing should have changed.
- [ ] Do it again and confirm this time. Then `ctrl + shift + p` →
      `Dry Run: Applied Changes` and check the entry is there with both the
      down migration and the rescue file.

### Comparing two databases

- [ ] `ctrl + shift + p` → `Dry Run: Compare With Another Database`.
- [ ] Paste the same connection string as the current one.
- [ ] **Expect:** "The two schemas match."

---

## Themes — the gap the harness has

The harness has only ever rendered a dark theme, and its colours are
stand-ins.

- [ ] `ctrl + k` then `ctrl + t`, choose **Light+ (default light)**.
- [ ] Re-run a preview and open the schema explorer.
- [ ] **Look for:** text the same colour as its background, invisible borders,
      badges you cannot read, the diagram's edges vanishing.
- [ ] Repeat with **Dark High Contrast**.

This is where the red-on-red Drop button would have shown up, and it is the
check most worth doing carefully.

---

## Reporting anything broken

A screenshot is enough. If a button does nothing, the useful extra detail is in
**Help → Toggle Developer Tools → Console** in the Extension Development Host
window: a red line there names the file and the line number.

Also worth pasting: the **Dry Run** output channel
(`ctrl + shift + u`, then pick **Dry Run** from the dropdown). Failures that are
deliberately not shown as dialogs are written there.
