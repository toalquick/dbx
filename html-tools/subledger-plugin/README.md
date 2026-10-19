# Subledger Finder for DBX

A universal frontend plugin ported from `../subledger-finder.html`. It adds a workbench and a **Troubleshoot subledgers** action to database and table context menus. Requires the updated DBX build from this checkout with database plugin context-menu support (DBX 0.6.44 / Host API 1.4). Earlier builds reject the new database menu target. The original standalone tool is preserved.

## Install and use

Start the rebuilt DBX app from `../../target/aarch64-apple-darwin/release/bundle/macos/DBX.app` before installing this plugin. Quit the previous DBX instance first.

1. In DBX, open **Plugin Center → Settings**, enable development installation of unsigned packages, and install `dist/dlsoftware.subledger-finder-1.0.3-universal.dbxp` as a local package. This locally built package is unsigned; ordinary signed marketplace installation does not apply.
2. Open the database connection. Right-click the database (for example, `quick3_no_007`) or a table in the sidebar and choose **Troubleshoot subledgers**. Alternatively, open the workbench from Installed plugins and enter the open connection ID.
3. Select customer or supplier, enter one client UID and the entity UIDs, then enter starting subledger UIDs or `*` for all. The connection ID and selected database are filled automatically from the database menu; check schema and SQL dialect. PostgreSQL, SQL Server, MySQL/MariaDB and SQLite SQL generation is supported; choose the dialect manually if the table context does not include it.
4. Choose an open DBX connection or two complete CSV exports, then click **Find connected subledgers**. Live reads use DBX's per-plugin, per-connection consent dialog. No credentials are exposed to the plugin.
5. Review connected rows, warnings and correction SQL. Copy the SQL into DBX's SQL editor. Run it in a transaction, verify affected row counts, and commit only after checking the result.

The plugin API permits read-only SQL. Corrections are generated for review and execution in the normal editor; the plugin never executes DELETE or UPDATE statements. The accompanying DBX build adds database context-menu support. The plugin needs no backend sidecar, CDN, or network permission.

## Snapshot and restore (PostgreSQL 12+)

Version 1.0.3 adds **Snapshot and restore both tables**. It works with the DBX build used for 1.0.2; no new application build is needed. Snapshot and restore SQL must be executed in DBX's SQL editor because the sandbox plugin only has read access.

A snapshot captures **every row and column in both tables, for all clients**. It does not use the analysis client, customer/supplier or seed filters. Full copies preserve values in columns the analysis does not load, including exact decimals, large UIDs, nulls, binary data, JSON, dates, and generated column results.

To take a snapshot:

1. Open the plugin from the database menu. Select **Open DBX connection**, check the database and PostgreSQL dialect, and enter the tables' schema explicitly (usually `public`). Client/entity inputs are not required to prepare a snapshot.
2. Keep the generated snapshot ID or choose a descriptive ID. Click **Prepare snapshot SQL**, then **Save recovery plan**. The recovery JSON records the database, schema and ID; it contains no row data or credentials.
3. Copy the generated SQL into DBX's SQL editor and execute the **entire DO statement**, preferably with autocommit enabled. Only a successful execution creates the snapshot. The plugin does not claim that preparing or saving SQL has created one.
4. Click **Check snapshot** to confirm the capture timestamp and backup row counts through a read-only DBX query. Keep the backup tables and recovery plan before running corrections. Optionally save the create and restore SQL files using **Save SQL file**.

The snapshot uses two persistent copy tables (`dbx_sl_<ID>` and `dbx_sbh_<ID>`) plus one metadata table (`dbx_snap_<ID>`) in the selected schema. It locks both source tables against writes while copying, so the two copies are consistent. It requires sufficient disk space, schema CREATE permission, SELECT permission and table-lock privileges. It refuses to overwrite an existing snapshot ID. Copies and metadata must not be edited or deleted while needed for recovery; normal database permissions/default privileges apply.

To revert:

1. Keep the same snapshot ID, or **Load saved recovery plan** after reopening the plugin. Check that the selected connection is the intended server.
2. Click **Prepare restore SQL**, copy it to the recorded database's SQL editor, and execute the entire statement.
3. Success means both tables' contents have been compared with their snapshots, including duplicate row counts and all column values. The backup tables remain available for repeated recovery.

Restore removes rows added since capture, updates existing rows in place, and reinserts deleted rows with their original IDs. **All clients in both tables are reverted**, not just the analysis selection. It preserves the original tables, constraints and triggers. Identity keys are restored explicitly and generated columns are recalculated and verified. Each table must have unique, non-null `(clientuid, uid)` keys; non-key identity columns require a custom recovery script.

Create and restore each run as one atomic PostgreSQL DO statement. Restore locks the tables, checks the database, original table identities, column definitions and backup row counts, then verifies the final rows. Errors roll back the operation; if run inside an existing transaction, issue ROLLBACK after an error and commit only after successful verification. Snapshotting with row-level security that would hide rows fails instead of saving partial data. Ordinary tables are supported; views, foreign tables, partitioned tables and inheritance are rejected.

External foreign keys referencing rows that would be removed, triggers, or constraints can prevent a restore. They are never disabled, and failures roll back all row changes. This is **row-data recovery**, not a rollback of schema, sequence counters, other tables or external trigger effects. Snapshot tables reside in the same database and do not replace normal database backups.

## Analysis and correction behavior

Connections follow both reference fields and nonempty, nonzero history identity IDs repeatedly until the entire connected group is found, within the selected client and entity scope. Links to customers/suppliers outside that selection are excluded; include their UIDs to investigate them together. Missing starting UIDs and duplicate row UIDs are rejected.

For each subledger, the earliest history row is the one with the lowest numeric UID. All later loaded history rows become exact DELETE candidates. The first row's balance and basebalance become the proposed subledger balances. Missing history, a nonzero first identity ID, inconsistent first balancechange, and differences from the subledger amount are reported. Missing/invalid amounts block the correction preview rather than silently converting them to zero.

IDs and decimal amounts remain text; UID ordering uses BigInt and decimal comparison avoids floating-point arithmetic. Live reads cast numeric values to text and page past the host's 5,000-row limit using UID keysets. Truncation must be exhausted before analysis can proceed. CSV accepts BOM, case-insensitive headers, commas/semicolons/tabs, quoted delimiters, escaped quotes, and embedded newlines. Empty fields and `NULL` become null.

DELETE predicates include client UID, subledger UID, exact history UID, original balance/basebalance/balancechange and identity ID. UPDATE predicates include client UID, subledger UID, entity UID, and original balances. Rows inserted after loading are not swept into a broad deletion. These checks do not provide a consistent snapshot across both tables or detect every concurrent change; reload and re-analyze after changes and check row counts in a transaction. CSV exports must contain the complete relevant history, including the earliest row. The plugin cannot establish completeness of an external export.

Expected columns:

- `subledger`: `uid`, `clientuid`, `customeruid` or `supplieruid`, `referencenumber`, `crossreferencenumber`, `amount`, `balance`, `basebalance`; optional `description`, `journaldate` for CSV. Live loading selects both optional display columns.
- `subledgerbalancehistory`: `uid`, `clientuid`, `subledgeruid`, `identityid`, `balance`, `basebalance`, `balancechange`.

Schema names must be simple identifiers. This plugin assumes the existing tool's lowercase table and column names. Analysis data is not persisted by the plugin. Snapshots are stored as database tables, and recovery plans can be saved as JSON files. Changing inputs or connection context clears prepared SQL previews.

## Development

From this directory, with repository Node dependencies installed:

```sh
node --test test.mjs
```

Build with the installed DBX Plugin CLI:

```sh
dbx-plugin package .
```

Alternatively, use the repository's official Rust packager (Rust/Cargo required):

```sh
node package.mjs
```

Both produce an unsigned universal package in `dist/`. Build caches/staging stay in `.dbx-dev/`; neither tests nor documentation enter the package.

Automated tests cover graph closure, client/entity isolation, suppliers, wildcard selection, large IDs, exact decimal handling, malformed CSV, invalid inputs, exact guarded SQL, paginated reads, UI rendering/copy/invalidation, and execution of generated SQL against a SQLite fixture. Live integration with a real accounting database must be verified in DBX.

## Version 1.0.1

Fixed live loading to order and page by the qualified numeric source UID rather than the text-cast output alias. This prevents false unordered-UID errors and skipped rows across digit boundaries. Install the newer package, close the old workbench, and reopen it before loading data again. Regression tests execute the generated paging queries against SQLite for both tables and retain duplicate/decreasing-UID rejection.

## Version 1.0.2

Moved the connection context-menu entry to the database context menu. Right-clicking a database supplies its canonical database name and parent connection ID; it also supplies the connection type for SQL dialect selection. Choosing another database refreshes the workbench context and clears previous results. Requires rebuilding/restarting DBX with the accompanying host changes, then installing the 1.0.2 package and reopening the workbench.

## Version 1.0.3

Added full PostgreSQL table snapshots, persistent backup metadata, atomic restore SQL with final row verification, saveable SQL and recovery-plan files, recovery-plan import, and read-only snapshot verification. Existing rows are restored in place to preserve references, deleted rows are reinserted, and post-snapshot rows are removed. No new DBX rebuild or permissions are required.

PostgreSQL integration tests run against the [PGlite PostgreSQL runtime](https://pglite.dev/docs/) using only disposable in-memory databases:

```sh
npm install --prefix .dbx-dev --cache .dbx-dev/npm-cache --no-save --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.5.10
node --test test.mjs test-postgres.mjs
```

The test-only runtime stays in the ignored development directory and is not shipped with the plugin. Tests cover full-column recovery, exact values and IDs, new/deleted rows, repeated recovery, duplicate snapshot names, database/schema guards, backup completeness, external references, trigger failures, row-level security, and recovery-plan UI flows.

Implementation references: PostgreSQL [identity overrides](https://www.postgresql.org/docs/16/sql-insert.html) and [table locks](https://www.postgresql.org/docs/16/sql-lock.html).
