Personal mods on top of dbx, in order — all verified (specs + typecheck), built, and hotfixed into the installed app. (#10 and #11 were removed once upstream shipped equivalents; numbering kept.)

**TLDR**

- **Snippets** — VS Code import/export, list filter, bulk delete with shift-click ranges (#2, #3, #5, #12, #39), quick-add from the editor's context menu (#24), `$0` final cursor position (#23), a typed table/column name outranks a colliding snippet trigger (#28), a partially typed prefix keeps tables/columns ahead of snippets (#44), and triggers containing spaces match their space-free spelling (#45)
- **Result grid** — DBeaver-style FK drill-through (#4) with a Back button / Alt+← that retraces the drill chain (#43), copy-SQL buttons for indexes, foreign keys, and constraints (#6, #7, #9), CSV export options dialog (#19) with a type-aware "strings" quote mode in export and copy extractors (#42), uncheck-all / show-only-filtered in the Columns dropdown (#33)
- **Keyboard** — VS Code-style Ctrl+D occurrence selection (#13), F3 opens the database selector and hands focus to the editor (#18, #21), Ctrl+Shift+C commits the transaction (#22), Alt+1..5 copy a first-row value (#30), Ctrl+Alt+Enter replaces all in the find/replace panels (#35), configurable shortcut for "Convert to delimited text" (#1)
- **Dialogs** — Enter confirms everywhere: delimited list (#8), SQL parameters (#14), danger confirms (#16), update center (#29); the SQL parameter dialog also stays open on outside clicks (#17)
- **Search & parameters** — double-Shift database object search that opens the object's definition (#20, #25), with type filter chips and the sidebar's icons/colors (#34); unfilled SQL parameters send NULL (#26)
- **Errors** — full PostgreSQL error reports with failed statements' notices (#36), live notice streaming and a readable error banner (#37), query/edit errors never finish silently (#38)
- **Structure editor** — the columns tab colors each column's type with the grid's palette, and its search filters rows instead of only marking them (#31)
- **Misc** — Postgres foreign-server browser (#15), GitHub Copilot as a first-class AI provider (#27) that signs in with your GitHub account (#46), MySQL reserved-word identifiers backticked (#40), hotfix build profile (#32)

1. Configurable keybinding for "Convert to delimited text"
The shortcut became user-configurable in Settings → Shortcuts instead of a hardcoded binding.
shortcutRegistry.ts, EditorSettingsDialog.vue

2. VS Code snippets importer
Settings → Snippets → Import reads VS Code snippets JSON (.json / .code-snippets): parses prefix/body pairs, auto-renames on prefix collisions, size-caps the file, and merges into the snippet draft without touching saved settings until Apply.
vscodeSnippetsImport.ts, EditorSettingsDialog.vue

3. Bulk snippet delete
Checkbox column + select-all in the snippets list, with a confirm dialog for deleting multiple selected snippets at once.
EditorSettingsDialog.vue

4. DBeaver-style FK drill-through
FK cells in any result grid get a hover arrow icon plus a context-menu entry that jumps to the referenced parent row (orders.useruid → the matching users row). Opens in the same pane (reuses the tab on table tabs, runs the lookup in-place on query tabs without clobbering the editor SQL); forward FKs only, works on JOIN results via strict per-source FK resolution. Two backend fixes came with it: unqualified postgres sources now default the FK lookup's schema to public (an empty schema matched nothing, so query-tab results resolved zero FKs), and the drill-through SELECT no longer injects large-value preview marker columns, which had shown up as ghost columns on query tabs.
dataGridForeignKeyNavigation.ts, useDataGridSourceForeignKeys.ts, useNavigationTargets.ts, DataGrid.vue, ContentArea.vue, postgres.rs (list_foreign_keys)

5. Snippets export
Settings → Snippets → Export saves snippets back to VS Code JSON (duplicate labels get -2/-3 suffixes; no success toast when you cancel the save dialog).
vscodeSnippetsImport.ts (serializeVscodeSnippetsFile), EditorSettingsDialog.vue

6. Index copy-SQL
Per-index Copy SQL button in the table-info drawer's Indexes tab: dialect-correct CREATE INDEX — UNIQUE/PK handling, raw key expressions, postgres operator classes and USING method, SQL Server CLUSTERED/NONCLUSTERED + INCLUDE, partial-index WHERE, per-dialect quoting incl. the JDBC quote-only-when-required mode. Hidden for MongoDB.
indexCreateSql.ts, DataGridTableInfoPanels.vue, DataGrid.vue

7. Foreign-key copy-SQL
Per-constraint Copy SQL button in the Foreign Keys tab: ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY … REFERENCES …, with composite FKs merged into one statement, ON DELETE/ON UPDATE actions (NO ACTION omitted), and cross-schema reference qualification. Hidden for MongoDB.
foreignKeySql.ts, DataGridTableInfoPanels.vue, DataGrid.vue

8. Enter-to-confirm in the delimited-list dialog
The dialog body is wrapped in a form whose submit runs Confirm (the only submit button), so Enter in any field applies the conversion. Inert while the preview is empty (Confirm disabled); Escape still closes.
DelimitedListDialog.vue

9. Constraints copy-SQL
Per-constraint Copy SQL button in the Constraints tab: uses the server-reported definition verbatim when complete (pg_get_constraintdef), wraps a bare check expression in CHECK (…), otherwise reconstructs the body from type/columns/reference metadata; constraints with nothing to reconstruct copy as an explanatory SQL comment. Hidden for MongoDB.
constraintSql.ts, DataGridTableInfoPanels.vue, DataGrid.vue

10. Alphabetical column sort in transposed row view
Removed — upstream now ships its own (header-cell sort button; note theirs collates without numeric ordering, so col10 sorts before col2).

11. Dark-mode native dropdown fix
Removed — upstream now styles native select popups for dark mode (color-scheme on :root/.dark plus option styling with popover tokens).

12. Snippet filter in Settings
Filter box above the snippets list: narrows by label, prefix, or SQL body (case-insensitive) with a live "Showing X of Y" count, a clear button, and a no-match row. The header select-all follows the filter (selects exactly the visible rows); hidden rows keep their selection.
EditorSettingsDialog.vue

13. VS Code-style Ctrl+D word/occurrence selection in the SQL editor
First press selects the word at the caret, each further press adds the next occurrence as another cursor+selection, and the multi-selections copy/paste normally. The occurrence commands already existed on IntelliJ-style keys (Alt+J / Ctrl+G); the default is now Ctrl+D. "Duplicate line" (the same command as Copy line down) is unbound by default and still assignable; saved shortcuts migrate to the new pairing automatically.
shortcutRegistry.ts, codemirrorSearchKeymap.ts, queryEditorOccurrenceSelection.ts (pre-existing), QueryEditor.vue

14. Enter-to-execute in the SQL parameter dialog
The dialog body is wrapped in a form whose submit runs Execute (the only submit button), and initial focus goes to the first parameter input — so Enter runs the query instead of activating the previously auto-focused "Clear values" header button.
SqlParameterDialog.vue

15. Postgres foreign-server (remote links) browser
Postgres connections get a "Foreign Servers" group in the sidebar tree: expanding lists every cataloged remote link (pg_foreign_server); clicking one opens a details dialog with FDW wrapper, owner, server type/version, connection options, comment, user mappings, and mounted foreign tables. A "Copy CREATE SERVER SQL" button reconstructs the statement plus ALTER SERVER … OWNER TO; user mappings are excluded because pg_user_mappings hides passwords, so the DDL would silently drop credentials.
types.rs (ForeignServerInfo), postgres.rs (list_foreign_servers), schema.rs/_core, commands/schema.rs, lib.rs, dbx-web routes, postgresForeignServers.ts, ForeignServerDetailsDialog.vue, connectionStore.ts, SidebarTreeRuntimeHost.vue, treeNodeClick/Icon/Group.ts, sidebarTreeItemLayout.ts, ConnectionTree.vue

16. Enter-to-confirm and Escape-to-close in the danger confirmation dialogs
Every destructive confirmation (row UPDATE/DELETE, drop/truncate, batch drops, type-the-name confirms, …) confirms on Enter: form wrapper, Confirm is the only submit control, Enter stays inert while the action is gated. Escape closes. The shared Button component now defaults to type="button" (submit must be opted into), so no button inside a form silently submits. Upstream's open-auto-focus on the confirm button was kept on top.
DangerConfirmDialog.vue, Button.vue, __tests__/DangerConfirmDialog.spec.ts

17. SQL parameter dialog stays open when clicking outside it
The dialog is modeless: no overlay, clicking outside doesn't dismiss it, and the editor behind stays interactive — text can be selected and copied into a parameter while it's on screen. Escape/Cancel/Execute/Ignore still close it; Escape now closes an open value-history suggestion popover first instead of being swallowed by it.
SqlParameterDialog.vue, __tests__/SqlParameterDialog.spec.ts

18. F3 opens the database selector dropdown
Rebindable. The dropdown opens with its filter input focused and the current database highlighted — type, arrow keys, Enter. F3 keeps its meaning where it already had one (grid: next page; open editor search panel: find-next); the fix that made it work is that CodeMirror's stock F3 binding no longer marks the key handled when its panel is closed, so it reaches the global handler.
shortcutRegistry.ts, keyboardShortcuts.ts, codemirrorSearchKeymap.ts, App.vue, SqlEditorWorkspace.vue, EditorGroup.vue, EditorToolbar.vue, SearchableSelect.vue, QueryEditor.vue, SqlFormatterSettingsPanel.vue

19. CSV export options dialog
CSV exports open an options dialog first: quoting mode (all / only when needed / off), delimiter (comma, semicolon, tab→.tsv, pipe, custom), quote character, and a header-row toggle. "Only when needed" quotes on delimiter/quote-char/line-break. All three export paths honor it — the Rust streaming result/table exporters (a CsvTextFormat threaded through every formatter, serde-defaulted for old payloads) and the in-memory frontend fallback. Enter confirms, Escape aborts; a custom delimiter/quote char is required before Confirm enables.
CsvExportDialog.vue, csvExportDialog.ts, csvQuoteMode.ts, exportFormats.ts, useDataGridExport.ts, tauri.ts, http.ts, legacyWebViewRegexCompat.spec.ts, en.ts, zh-CN.ts, csv_export.rs (dbx-formats), query_result_export.rs, table_export.rs, csv_export.rs (dbx-core), commands/csv_export.rs (src-tauri)

20. Double-Shift database object search
Pressing Shift twice quickly (within 400 ms, no other key between — typing capitals never trips it) opens a search dialog scoped to the active database: every table, view, materialized view, procedure, function, and trigger, filtered with the quick-open matching (exact → initials → prefix → pinyin → word-prefix → substring → fuzzy, highlighted). Tables/views/materialized views open as data tabs; routines open their source. Schema-aware engines fan out over the database's schemas (parallel queries capped at 50, system schemas filtered first — postgres carries one numbered pg_toast_N schema per table) so a schema-less tab doesn't produce an empty list; numbered pg_toast_ schemas are now classified as system everywhere.
doubleShiftGesture.ts, useDatabaseObjectSearch.ts, DatabaseObjectSearchDialog.vue, App.vue, visibleDatabases.ts, en.ts, zh-CN.ts

21. Focus moves to the query editor after picking a database with F3
Enter or click in an F3-opened selector hands focus to the query editor (deferred one frame past the popover's own focus restore). Click-opened dropdowns behave as before; dismissing the F3 dropdown with Escape or an outside click cancels the hand-off.
EditorToolbar.vue, EditorGroup.vue, QueryEditorSurface.vue, ContentArea.vue, querySurfaces.ts, QueryEditor.vue, __tests__/EditorToolbar.databaseSelectFocus.spec.ts

22. Ctrl+Shift+C commits the transaction
Rebindable ("Commit transaction"). Acts on the active editor group's tab and only consumes the keys when that tab actually holds an open transaction (manual mode, or an auto-commit tab that kept an explicit BEGIN).
shortcutRegistry.ts, keyboardShortcuts.ts, EditorGroup.vue, SqlEditorWorkspace.vue, App.vue, en.ts, zh-CN.ts, __tests__/shortcutRegistry.spec.ts, __tests__/keyboardShortcuts.spec.ts

23. $0 final cursor position in snippets
$0/${0} mark where the cursor lands once the tabstops are done (VS Code style): they're renumbered to one past the highest tabstop — CodeMirror's final field — so Tab walks the fields and ends there; multiple $0 become one multi-caret field. Only zero is translated: bare $1/$2 stay PostgreSQL bind parameters, and \$0 stays literal.
sqlCompletion.ts, __tests__/sqlCompletion.snippet.spec.ts

24. Add-snippet dialog from the editor's right-click menu
"Add snippet" in the editor's context menu opens a small dialog (label, prefix, SQL body); with a selection the body comes prefilled with it. Saves immediately (prefix must be non-empty and unique — duplicates flagged live), Enter confirms, Escape cancels, and it works in read-only editors since saving a snippet never touches editor content.
SnippetQuickAddDialog.vue, QueryEditor.vue, en.ts, zh-CN.ts, __tests__/SnippetQuickAddDialog.spec.ts, __tests__/QueryEditor.snippetQuickAdd.spec.ts

25. Double-Shift search opens the object definition, with a View button for data
Selecting a table/view/materialized view opens its source instead of its content: tables open the structure editor's DDL tab, views open the DDL view dialog (the same surfaces as Ctrl+click DDL mode). Each row keeps a "View" button for the data tab (the old behavior); routines are Source-only. Deliberately a hard behavior change with no setting; Ctrl+P quick-open still opens data tabs.
App.vue, DatabaseObjectSearchDialog.vue, en.ts, zh-CN.ts, __tests__/DatabaseObjectSearchSourceNavigation.spec.ts, __tests__/DatabaseObjectSearchDialog.spec.ts

26. Unfilled SQL parameters send NULL
An empty value in the run-query parameter dialog substitutes NULL instead of an empty string literal (`WHERE name = :name` left blank matches nothing, not every row with name = ''). Covers String and Boolean (Number/Null already did). Raw keeps its contract (empty stays unresolved; `''` as Raw sends an explicit empty string), typed whitespace is still data, and a placeholder embedded inside a larger literal still splices nothing. The field placeholder says "Enter value (empty sends NULL)".
sqlParameters.ts, __tests__/sql/sqlParameters.spec.ts, __tests__/SqlParameterDialog.spec.ts, en.ts, zh-CN.ts

27. GitHub Copilot as a first-class AI provider
Settings → AI has a "GitHub Copilot" entry (GitHub mark logo) with endpoint, Bearer auth, and a gpt-4.1 default prefilled — only the token is left to fill (a PAT from an account with an active Copilot subscription). The API is OpenAI chat-completions shaped but sits directly under the host with no /v1, unlike every other OpenAI-style provider where dbx auto-adds it — so endpoint and model-list resolution special-case Copilot. Everything downstream rides the existing OpenAI-compatible path.
types/ai.ts, settingsStore.ts, AiProviderLogo.vue, public/icons/ai/githubcopilot.svg, EditorSettingsDialog.vue, en.ts, zh-CN.ts, __tests__/aiConfigOrdering.spec.ts, __tests__/settingsStore.spec.ts, ai.rs, ai_effort.rs, ai_model_filter.rs (crates/dbx-ai-provider)

28. A fully typed table/column name outranks a colliding snippet trigger
Typing a complete identifier no longer accepts a snippet instead: the exact-match pass checks first whether a table or column exactly matches the typed word, and colliding snippets are demoted to plain ranking (their exact-trigger bonus stripped — they still lead the pool right below the identifier). Exact function/keyword matches still yield to exact snippet triggers, and non-colliding triggers still jump to the top.
sqlCompletion.ts (exact-match pass), __tests__/sql/sqlCompletion.snippet.spec.ts

29. Enter runs the update dialog's primary action
Enter triggers the primary action per state (Download in Background → Restart & Update → Restart; Update Now on component tabs), with every branch re-checking the button's disabled conditions — inert while downloading/installing/gated, key repeats ignored, Cancel never fires. Enter on tab buttons, links, and the source dropdown keeps its native behavior; the primary buttons are the only type="submit" controls.
UpdateDialog.vue, UpdateDialog.spec.ts

30. Alt+1..5 copies a value from the first row of the current result
Alt+N copies the first-row value of column N from the active tab's current result (rebindable), only consuming the keys when there is something to copy. The value comes from the projected active result run, null copies as empty string, and the toast names the column with a 60-char preview.
queryResultFirstValue.ts, shortcutRegistry.ts, keyboardShortcuts.ts, EditorGroup.vue, SqlEditorWorkspace.vue, App.vue, en.ts, zh-CN.ts, __tests__/queryResultFirstValue.spec.ts, __tests__/editor/shortcutRegistry.spec.ts, __tests__/editor/keyboardShortcuts.spec.ts

31. Type coloring + real filtering in the structure editor's columns tab
(1) The Type column is colored with the result grid's per-type palette (data-grid-type-* classes, light + dark + custom schemes), covering the type picker and the disabled fallback input; unknown types keep the default foreground. (2) The column search box filters the list instead of only marking matches: rows keep their true ordinals (drag-reorder, context menus, pending-change indicators unaffected), pending-edit rows are never filtered out, Escape/✕ clears, and a no-match query shows an empty state. Matching rows additionally wear the subtle match stripe.
TableStructureEditor.vue, en.ts, zh-CN.ts, __tests__/TableStructureEditor.columnSearchFilter.spec.ts

32. Hotfix build profile
A `hotfix` cargo profile (inherits release, no LTO + incremental + codegen-units 16, own target dir) cuts small-edit rebuilds from ~24 min to a few minutes — release's fat LTO + single codegen unit re-optimizes the whole dependency graph on every rebuild, and the embedded frontend forces one every build. Build from src-tauri: `pnpm build` then `cargo build --profile hotfix --features custom-protocol` — the feature flag is mandatory (without it the exe launches but serves the dev-server URL). Costs a few percent of Rust-side speed and a ~89 MB exe vs ~70.
Cargo.toml (workspace root, [profile.hotfix])

33. Uncheck-all and show-only-filtered in the result grid's Columns dropdown
Two bulk actions next to Invert / Reset order / Show all: "Hide all" unchecks everything (the first column stays checked — a fully unchecked state is unrepresentable downstream) and "Show filtered only" makes the visible set exactly the popover's search matches. Both ride the existing batch-visibility handles, so every grid hosting the popover gets them.
DataGridColumnLayoutPopover.vue, en.ts, zh-CN.ts, __tests__/dataGridColumnLayoutPopover.spec.ts

34. Type filter and sidebar icon/color coding in the double-Shift object search
A chip row between input and results toggles object kinds (one per kind the database actually has; hidden when there's only one; all on for every fresh load). Result rows lead with the sidebar's icon for their kind and the type badge is tinted with the same color — the mapping lives in one shared getObjectKindIconInfo() that the sidebar tree also uses, so the two can't drift.
treeNodeIcon.ts, useDatabaseObjectSearch.ts, DatabaseObjectSearchDialog.vue, __tests__/useDatabaseObjectSearch.spec.ts, __tests__/DatabaseObjectSearchDialog.typeFilter.spec.ts

35. Ctrl+Alt+Enter replaces all in the search-and-replace panels
Both find/replace surfaces — the editor's Ctrl+H panel and the grid's search bar — run Replace All on Ctrl+Alt+Enter (VS Code's accelerator), firing from whichever input has focus with the same gates as the button. With the replace row collapsed the shortcut is swallowed: the replacement text is hidden and possibly stale. Buttons advertise the shortcut in tooltips; the shared editor panel gives Nacos and cell-detail editors the accelerator too.
replaceAllShortcut.ts (isReplaceAllShortcut), EditorSearchPanel.vue, DataGridSearchBar.vue, __tests__/editor/replaceAllShortcut.spec.ts, __tests__/editor/EditorSearchPanel.replaceAllShortcut.spec.ts, DataGridSearchReplace.spec.ts

36. PostgreSQL errors keep their full report, and failed statements keep their notices
(1) tokio-postgres's Error Display is literally "db error" — the real report rides in the source chain. Every statement path (manual-transaction runner, BEGIN/SET/ROLLBACK wraps, transactional DML batch) now uses the shared DbError formatter, extended with the fields its Display omitted: the inner SQL statement of a nested failure, the "PL/pgSQL function … line N" trace, and the SQLSTATE — psql's field layout. (2) A failed statement's RAISE NOTICE lines are attached to its error as "Server messages:" instead of being drained and discarded, and the manual-transaction runner now drains notices per statement so its Messages tab works at all.
postgres.rs (pg_error_to_string context lines, pg_error_to_string_plain, append_postgres_notices_to_error, drain_postgres_notices), query/mod.rs (execute_manual_txn_postgres_statement, exec_tx_pg_statements, setup wraps); tests: postgres.rs unit + live-gated regressions (DBX_TEST_POSTGRES_URL), query/mod.rs fake-server snapshots

37. Live PostgreSQL notice streaming while a statement runs, and a readable error report
Notices now stream while a statement runs: a per-connection tap fires the moment a notice hits the wire, statement-indexed `query-statement-notices` events ride a 100 ms coalescing batcher (first notice immediate), and the frontend appends per run — the output view auto-switches to Messages on the first notice (once per run, never overriding a user redirect) and the loading spinner shows a one-line ticker with the latest notice. At settle, a failed statement's streamed notices stay visible. The error banner splits the report: the first line stays red, everything after (DETAIL, inner SQL, trace, HINT, SQLSTATE, server messages) renders in a selectable monospace panel.
types.rs, postgres.rs, query/mod.rs, src-tauri/commands/query.rs, dbx-web/routes/query.rs, tauri.ts, http.ts, api.ts, queryStore.ts, database.ts, openTabsPersistence.ts, ContentArea.vue, QueryLoadingState.vue, ErrorBanner.vue, en.ts, zh-CN.ts; tests: postgres.rs, query/mod.rs, commands/query.rs, __tests__/ErrorBanner.spec.ts, __tests__/QueryLoadingState.spec.ts, __tests__/queryStore.streamingNotices.spec.ts, openTabsPersistence.spec.ts, connectionStore.nacosNamespaceAccess.spec.ts, ExportProgressPopover.spec.ts, RedisKeyBrowser.subtreeFill.spec.ts (locale-stable fixtures)

38. Query/edit errors can no longer finish silently
(1) A run that ends with an error lands where the error is visible — result grid for single statements, execution summary for multi-statement — instead of staying on whatever view was active; skipped when the user redirected the view mid-run or the run was cancelled. (2) The first statement error of a running batch flips to Summary immediately. (3) The Summary button carries a red error-row count badge. (4) A run that errors in a background tab sets a red dot on the tab plus a one-shot toast with an open-tab action. (5) A save that affects 0 rows (trigger RETURN NULL, ON CONFLICT DO NOTHING) warns instead of silently clearing pending changes, and save errors persist until the next save or an explicit discard — never wiped by the next keystroke. Cancelled runs stay quiet everywhere.
database.ts, queryStore.ts, useSqlExecution.ts, QueryResultViewSwitcher.vue, ContentArea.vue, TabExecutionStatus.vue, useDataGridEditor.ts, DataGrid.vue, ErrorBanner.vue, openTabsPersistence.ts, en.ts, zh-CN.ts; tests: __tests__/queryStore.errorVisibility.spec.ts, useSqlExecution.spec.ts, QueryResultViewSwitcher.spec.ts, TabExecutionStatus.spec.ts, useDataGridEditor.spec.ts, ErrorBanner.spec.ts

39. Shift-click range selection for the snippets checkboxes
Shift-clicking a second checkbox applies the clicked box's new state to every row in between (over the filtered rows; the anchor is the last plain-clicked row and survives filter changes). A shift-click with no usable anchor falls back to a plain toggle. Implementation rides the native toggle completely — nothing is preventDefault'ed, because canceling checkbox clicks is unreliable on WebView2; the range logic is a pure helper in lib/sql.
snippetRangeSelection.ts, EditorSettingsDialog.vue; tests: __tests__/snippetRangeSelection.spec.ts, EditorSettingsDialog.snippetsBulkDelete.spec.ts

40. MySQL reserved-word columns complete backticked
Autocompleting a column whose name is a MySQL reserved keyword now inserts it backticked (`call`, `set`, `read`, …): the MySQL-only set in requiresMysqlIdentifierQuote is the complete MySQL 8.4 reserved list minus the Postgres set (~130 words added, verified word-by-word against the manual). Because the predicate is shared, data-tab generated SQL, the SQL Server bracket heuristic, and GaussDB MySQL-compat quoting get the fix too. Postgres completions are unchanged (CALL isn't reserved there). ddlDisplay.spec.ts's fixture schema became MYDB — the old "SYSTEM" fixture is now on the reserved list.
sqlIdentifier.ts; tests: __tests__/sql/mysqlReservedIdentifierQuoting.spec.ts, ddlDisplay.spec.ts (fixture rename)

42. Type-aware "strings" quoting — CSV export and copy extractors
The original ask lived in the copy extractors, not the export dialog: a fourth CSV quote mode — in Settings ("Text values only"), the CSV export dialog ("Quote text values"), and everywhere a raw mode string reaches the backend — wraps every string value and every header in the quote character (with escaping and the formula guard) while numbers and booleans are written bare, so `0123` or date-like text stays recognizable as text on re-import. The same "strings" policy is now also a copy-extractor quote option (Copy → Configure / extractor dialog, "Strings only"): it applies to every delimited extractor — one-row, CSV/TSV/DSV/pipe, with or without headers — so copying a row with the one-row function quotes text cells (including JSON-serialized objects/arrays) and leaves numbers, booleans, and the NULL sentinel bare. The type split happens where cell types still exist — formatCsv on the TS side, push_csv_value_formatted's Value dispatch in Rust, and DsvCell's string-like flag in the extractors; NULL keeps its bare literal, and snapshot exports pass the mode through instead of coercing it to necessary. The extractor side is column-type-aware: MySQL/MariaDB's text protocol delivers every scalar as a JSON string (tinyint indistinguishable from varchar by value alone), so strings_policy_string_like consults the request column's data_type first — numeric/boolean first-words (tinyint(1) unsigned, int8, UInt32, decimal(10,2), …) are written bare even as text, everything else falls back to the value-type split. Honest limitation: the CSV-export path still classifies by JSON value type only (its formatting layer never sees column types), so a MariaDB strings-mode export quotes numeric text-protocol cells; the copy extractors are the fixed surface.
csvQuoteMode.ts, exportFormats.ts, useDataGridExport.ts, csv_export.rs (dbx-formats), snapshot_export.rs (dbx-core), CsvExportDialog.vue, EditorSettingsDialog.vue, dataGridCopyExtractor.ts (quotePolicy "strings"), DataGridExtractorDialog.vue, contract.rs + delimited.rs + mod.rs (dbx-sql-data), en.ts, zh-CN.ts; tests: __tests__/csvExportFormat.spec.ts, settingsStore.spec.ts, strings_quote_mode_quotes_text_values_headers_and_json_but_not_numbers_or_booleans (dbx-formats), strings_quote_mode_quotes_streamed_text_cells_like_all (dbx-core), strings_quote_policy_quotes_text_but_not_numbers_or_booleans + strings_quote_policy_quotes_headers_json_and_structural_risks + strings_quote_policy_uses_column_type_for_text_protocol_numbers + strings_quote_policy_numeric_column_type_overrides_number_values (dbx-sql-data)

43. Back button for the FK drill-through
A Back control at the start of the grid toolbar (both table and query tabs), plus Alt+← inside the grid when a restore point exists, retraces the drill chain: every same-pane FK jump records a restore point first — on a data tab the previous table target with its live WHERE filter (re-opened in place via the same reuse path, order rebuilt by default sort), on a query tab the SQL behind the previous result (re-run in the results pane, editor SQL untouched, multi-result groups preserved). The chain validates per hop: a data-tab entry only restores while the tab still shows the table that jump arrived at, a query entry only while the displayed result is still the jump's SQL — anything else (sidebar re-target, re-run query) drops the stale entries and hides the button, so Back never "undoes" a navigation it didn't make. Entries in flight are protected: from the push (or the back that rewrites the pane) until the new table metadata/result lands, the top entry is only hidden, not discarded — without this the toolbar computed evaluates mid-transition against the old table's identity and eats the freshly pushed entry, so the button never appeared at all and chained backs died after one step. New-tab fallbacks (pinned/executing tabs) don't record; those stay with Ctrl+Alt+← tab history (plain Alt+← stays free for the grid).
foreignKeyDrillBack.ts, useNavigationTargets.ts (drillBack option, executeSqlInQueryTabResults), DataGrid.vue (toolbar button, Alt+← in onGridKeydown); tests: __tests__/dataGrid/foreignKeyDrillBack.spec.ts, DataGridForeignKeyDrillThrough.spec.ts

44. Snippets rank below tables and columns
A snippet whose trigger merely prefix-matches the typed word no longer outranks the table or column being typed (its base boost drops from 4000 to below the identifier relevance boosts), so Enter no longer accidentally expands a snippet mid-identifier. Snippets still lead plain keywords, typing past the trigger ("sele" vs "sel") still defers to the real keyword, and an exactly typed custom trigger still jumps to the top when no identifier collides with it (#28 keeps guarding the collision case).
sqlCompletion.ts (buildSnippetItems baseBoost); tests: __tests__/sql/sqlCompletion.snippet.spec.ts

45. Snippet triggers with spaces complete by their space-free spelling
A snippet named/triggered "S item" never surfaced while typing: the completion prefix is a single word, and CodeMirror's matcher scores the whole option label — an interior space dumps spaced names into its heavily penalized gap tiers (a single-letter query that does not start the label is dropped outright), so the snippet sank below the render cap or vanished entirely. buildSnippetItems now also matches the whitespace-free spelling of the trigger and label ("S item" ↔ "sitem"), treats a fully typed space-free trigger as an exact trigger (top-of-list, still demoted by #28 when a table/column spells the same), and exposes the compact trigger as filterText so the CodeMirror-facing label starts with a word the user can actually type. Space-free triggers behave byte-identically to before (filterText stays the trigger; label matching keeps its outgrow-the-trigger gate); typing the literal "S item" with the space stays unmatchable — the space ends the word in any editor.
sqlCompletion.ts (buildSnippetItems, snippetCompactText/snippetCompactVariants); tests: __tests__/sql/sqlCompletion.snippet.spec.ts

46. GitHub login for the Copilot provider (OAuth device flow)
Copilot's chat API rejects personal access tokens — the mod-27 PAT-in-the-API-key-field setup could never work. The API wants a ~30-minute session token GitHub only mints through its own editor-client handshake, so this adds exactly that: a "Sign in with GitHub" card replaces the API-key row for Copilot (device code + github.com/login/device link, a poll loop with slow_down backoff and an expiry countdown, "Signed in as {login}" resolved from api.github.com/user, sign-out clears the stored token). The gho_ token the flow returns rides the existing encrypted api_key field — storage, config save, and the key-required gates are untouched. At request time every AI entry point (complete, stream, stream_with_tools, list-models, test-connection — but not the pure resolve-model-effort lookup) swaps the stored gho_ for a fresh session token via api.github.com/copilot_internal/v2/token and repoints the endpoint at the API host GitHub names for the account (fallback api.githubcopilot.com, so the session exchange also fixes enterprise users); session tokens are cached per gho_ token and refreshed 300 s before expiry, and requests carry the editor identity headers (editor-version / editor-plugin-version / user-agent) Copilot's gateway routes on. The swap shadows the request parameter at function entry because the retry closures re-clone the original request; PATs and empty keys get actionable sign-in errors instead of a cryptic 401. Desktop Tauri commands, web routes, and i18n (en/zh-CN) included. Sign-out is local-only (GitHub publishes no device-flow revocation endpoint), and a revoked-but-unexpired token keeps working until it expires or you sign in again.
copilot_auth.rs (dbx-ai-provider), ai.rs (apply_copilot_auth interception in complete/stream/stream_with_tools/list_models_core/test_connection_core, maybe_bearer_headers editor headers), lib.rs (dbx-ai-provider, dbx-core re-export), copilot_oauth.rs + mod.rs + lib.rs (src-tauri commands), routes/ai.rs + main.rs (dbx-web), types/ai.ts, api.ts, tauri.ts, http.ts, EditorSettingsDialog.vue, en.ts, zh-CN.ts; tests: copilot_auth.rs (device start/poll/exchange/cache, plus a wire-shape test: serde's enum-level rename_all renames only the tag values, so struct-variant fields stayed snake_case — the poll's access_token reached the frontend as access_token, the dialog read undefined, and Apply died on a silent TypeError; rename_all_fields puts it on the wire as accessToken), ai.rs (copilot_bearer_headers_carry_editor_identity, copilot_pat_keys_are_rejected_before_any_request), EditorSettingsDialog.copilotSignIn.spec.ts, featureMessages.spec.ts
