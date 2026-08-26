# The pass only you can do

The browser harness renders the real markup, stylesheet and scripts, and drives
them with real clicks, in both a dark and a light theme. Two other things now
also happen without you: `contract.test.ts` reads both halves of every panel and
checks that each message posted has a listener at the other end and each
listener has something that posts it — so a dead button or a command that sends
nothing no longer needs finding by hand.

What is left is what nothing but a person in a real editor can see:

1. **The extension host.** Keybindings, the Problems view, and the modal
   dialogs. Activation itself no longer needs you: `activation.test.ts` starts
   the extension against a stub VS Code and checks that it registers every
   command, puts the view in the activity bar, says nothing on the way up, and
   survives being started twice.
2. **The real theme.** The harness uses stand-ins for the VS Code colour
   variables. They are taken from the real themes, but they are still stand-ins.
3. **A real database round trip through the UI.** Every adapter is tested
   against a real server; none of those tests goes through a panel.
4. **Whether the whole thing is pleasant to use**, which no test has an
   opinion about.

So this is a list of exactly what to press. It is ordered by how likely each
one is to be broken, not by how the extension is organised.

---

## Setting up (once)

The extension is installed, so there is no `f5` any more:

```
npm run vsix
code --install-extension dryrun-0.0.1.vsix
```

1. Open `testbed/postgres-shop` as a folder in VS Code (`ctrl + k` then
   `ctrl + o`).
2. Click the **database icon in the activity bar**, down the left edge with the
   file explorer and search icons.
3. Paste the connection string from `testbed/postgres-shop/.env` into the box.
   The engine badge should say **PostgreSQL** before you press anything.
4. Press **Connect**. The panel should swap to a list of actions.

Everything below can be done from that panel; the command palette still works
if you prefer it.

Use `f5` instead only when you are changing the extension's own code — that
launches a second window running from source, and the sidebar behaves the same
way in it.

---

## The ten minutes that matter most

These are the newest and least verified. Tick as you go.

### 0. The front door

- [ ] The icon is in the activity bar and the panel opens.
- [ ] Typing into the box shows an engine badge **as you type**, before you
      connect. Try deleting the `postgresql://` prefix — it should still say
      PostgreSQL, guessed from the port.
- [ ] Paste something nonsense (`redis://localhost`). **Expect:** the Connect
      button goes grey and it says it does not know that scheme.
- [ ] Connect with **Remember this one** ticked, then disconnect. **Expect:**
      the connection appears under **Saved**, and clicking it reconnects
      without retyping anything.
- [ ] Click the **pencil** on a saved row, type a shorter name, press enter.
      **Expect:** the row keeps the new name after a reload of the window
      (`ctrl + shift + p`, then "Developer: Reload Window"). Press escape
      instead and it should go back to the old name unchanged.
- [ ] **The thing to catch:** it says connected but the actions do nothing, or
      a saved connection fails with "password is not in the keychain".

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

## Themes — now checked, but still worth a look

The harness renders both Light+ and Dark+ now and walks every element that
paints text, asking one question of all of them: can you read it. That sweep
found seven pieces of unreadable text, including a table's own name on a card
the preview had marked.

What it still cannot see is a theme other than those two — High Contrast, and
whatever you have actually installed.

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
