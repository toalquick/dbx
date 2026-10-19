// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The columns tab search filters rows (and colors the type column with the
// grid's per-type palette) instead of only marking matches. Rows with pending
// edits always stay visible so the filter cannot hide unsaved work.

const mocks = vi.hoisted(() => ({
  connection: {
    id: "structure-column-filter",
    name: "MySQL",
    db_type: "mysql",
    driver_label: "MySQL",
  },
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
  executeBatch: vi.fn(),
  listDataTypes: vi.fn(),
  buildTableStructureChangeSql: vi.fn(),
  buildMysqlAutoIncrementSql: vi.fn(),
  buildTableOwnerChangeSql: vi.fn(),
  getTablePartitionStatus: vi.fn(),
  getTableOwner: vi.fn(),
  updateEditorSettings: vi.fn(),
  loadObjectDdl: vi.fn(),
  invalidateObjectDdl: vi.fn(),
  loadObjectMetadataFacet: vi.fn(),
  invalidateObjectMetadataCache: vi.fn(),
  invalidateTableMetadataCache: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key) }) }));

vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  const Icon = defineComponent({ name: "Icon", setup: () => () => h("span") });
  return {
    AlertTriangle: Icon,
    Check: Icon,
    ChevronDown: Icon,
    ChevronLeft: Icon,
    ChevronRight: Icon,
    ChevronUp: Icon,
    ClipboardList: Icon,
    Copy: Icon,
    Database: Icon,
    Info: Icon,
    Keyboard: Icon,
    KeyRound: Icon,
    ListChevronsUpDown: Icon,
    Loader2: Icon,
    Maximize2: Icon,
    Pencil: Icon,
    Plus: Icon,
    RefreshCw: Icon,
    RotateCcw: Icon,
    Rows3: Icon,
    Save: Icon,
    Search: Icon,
    Settings: Icon,
    SlidersHorizontal: Icon,
    Trash2: Icon,
    UserRound: Icon,
    X: Icon,
  };
});

vi.mock("vue-virtual-scroller", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    // happy-dom has no layout, so render every item instead of measuring.
    RecycleScroller: defineComponent({
      name: "MockRecycleScroller",
      props: ["items"],
      setup:
        (props, { slots, attrs }) =>
        () =>
          h("div", { ...attrs, "data-recycle-scroller": "true" }, [slots.before?.(), ...(Array.isArray(props.items) ? props.items : []).map((item: unknown) => slots.default?.({ item, active: true }))]),
    }),
  };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      name: "Button",
      inheritAttrs: false,
      setup:
        (_props, { attrs, slots }) =>
        () =>
          h("button", attrs, slots.default?.()),
    }),
  };
});
vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      name: "Input",
      inheritAttrs: false,
      props: { modelValue: { type: [String, Number], default: "" } },
      emits: ["update:modelValue"],
      setup:
        (props, { attrs, emit }) =>
        () =>
          h("input", {
            ...attrs,
            value: props.modelValue,
            onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
          }),
    }),
  };
});
vi.mock("@/components/ui/badge", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Badge: defineComponent({
      name: "Badge",
      inheritAttrs: false,
      setup:
        (_props, { attrs }) =>
        () =>
          h("span", attrs),
    }),
  };
});
vi.mock("@/components/ui/tabs", async () => {
  const { defineComponent, h } = await import("vue");
  // Unlike the other structure-editor specs, this one asserts on tab *content*
  // (the columns grid), so the mock Tabs components must forward their slots.
  const Tabs = defineComponent({
    name: "MockTabs",
    inheritAttrs: false,
    setup:
      (_props, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  const TabsContent = defineComponent({
    name: "MockTabsContent",
    inheritAttrs: false,
    setup:
      (_props, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  const TabsList = defineComponent({
    name: "MockTabsList",
    inheritAttrs: false,
    setup:
      (_props, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  const TabsTrigger = defineComponent({
    name: "MockTabsTrigger",
    inheritAttrs: false,
    props: { value: { type: String, required: true } },
    setup:
      (props, { attrs, slots }) =>
      () =>
        h("button", { ...attrs, type: "button", "data-tab-trigger": props.value }, slots.default?.()),
  });
  return { Tabs, TabsContent, TabsList, TabsTrigger };
});
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs }) =>
      () =>
        h("div", attrs),
  });
  return { DropdownMenu: Div, DropdownMenuCheckboxItem: Div, DropdownMenuContent: Div, DropdownMenuItem: Div, DropdownMenuTrigger: Div };
});
vi.mock("@/components/ui/popover", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs }) =>
      () =>
        h("div", attrs),
  });
  return { Popover: Div, PopoverContent: Div, PopoverTrigger: Div };
});
vi.mock("@/components/ui/tooltip", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs }) =>
      () =>
        h("div", attrs),
  });
  return { Tooltip: Div, TooltipContent: Div, TooltipTrigger: Div };
});
vi.mock("@/components/ui/searchable-select", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    SearchableSelect: defineComponent({
      name: "SearchableSelect",
      inheritAttrs: false,
      props: {
        modelValue: { type: String, default: "" },
        // The real component puts triggerClass on the trigger button's class —
        // the type column's palette class rides on it, so the mock must too.
        triggerClass: { type: [String, Array], default: undefined },
      },
      emits: ["update:modelValue"],
      setup:
        (props, { attrs }) =>
        () =>
          h("button", {
            ...attrs,
            class: Array.isArray(props.triggerClass) ? props.triggerClass.join(" ") : props.triggerClass,
            type: "button",
            "data-model-value": props.modelValue,
          }),
    }),
  };
});
vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs }) =>
      () =>
        h("div", attrs),
  });
  return { Select: Div, SelectContent: Div, SelectItem: Div, SelectTrigger: Div, SelectValue: Div };
});

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: (connectionId: string) => (connectionId === mocks.connection.id ? mocks.connection : undefined),
    // 上游为 oracle 约束/索引编辑新增的连接世代守卫：watch 在 setup 立即求值。
    connectionStateRevision: () => 0,
    isCurrentConnectionStateRevision: () => true,
  }),
}));
vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => ({ requestConfirmation: vi.fn() }) }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ tableStructureRefreshVersion: () => 0 }) }));
vi.mock("@/stores/historyStore", () => ({ useHistoryStore: () => ({ add: vi.fn() }) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { structureEditorDensity: "compact", sqlFormatter: {}, tableColumnTemplateFields: [], fontSize: 13, fontFamily: "monospace", theme: "default", generateSqlQuoteIdentifiers: true },
    updateEditorSettings: mocks.updateEditorSettings,
  }),
}));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false }, themePalette: { value: "pearl" } }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/sql/sqlHighlighter", () => ({ createShikiSqlHighlighter: vi.fn(async () => (sql: string) => sql) }));
vi.mock("@/lib/sql/sqlFormatter", () => ({
  formatSqlForDisplay: vi.fn(async (sql: string) => sql),
  sqlFormatDialectForDbType: vi.fn(() => "mysql"),
}));
vi.mock("@/lib/editor/editorThemes", () => ({ loadEditorTheme: vi.fn(async () => []), editorFontTheme: vi.fn(() => []) }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({
  loadObjectDdl: mocks.loadObjectDdl,
  invalidateObjectDdl: mocks.invalidateObjectDdl,
}));
vi.mock("@/lib/metadata/objectMetadataCache", () => ({ loadObjectMetadataFacet: mocks.loadObjectMetadataFacet, invalidateObjectMetadataCache: mocks.invalidateObjectMetadataCache }));
vi.mock("@/lib/metadata/tableMetadataCache", () => ({ invalidateTableMetadataCache: mocks.invalidateTableMetadataCache }));
vi.mock("@/lib/backend/api", () => ({
  executeQuery: mocks.executeQuery,
  executeBatch: mocks.executeBatch,
  listDataTypes: mocks.listDataTypes,
  buildTableStructureChangeSql: mocks.buildTableStructureChangeSql,
  buildMysqlAutoIncrementSql: mocks.buildMysqlAutoIncrementSql,
  buildTableOwnerChangeSql: mocks.buildTableOwnerChangeSql,
  getTablePartitionStatus: mocks.getTablePartitionStatus,
  getTableOwner: mocks.getTableOwner,
}));

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

const mountedApps: App[] = [];

interface DbTestColumn {
  name: string;
  data_type: string;
  nullable?: boolean;
  default_value?: string | null;
  comment?: string;
}

async function settle() {
  for (let i = 0; i < 30; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

async function mountEditor(dbColumns: DbTestColumn[]) {
  mocks.loadObjectMetadataFacet.mockImplementation(async (_request: unknown, facet: string) => {
    if (facet === "columns") return { value: dbColumns, cacheStatus: "remote" };
    if (facet === "comment") return { value: "", cacheStatus: "remote" };
    return { value: [], cacheStatus: "remote" };
  });
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(TableStructureEditor, {
    connectionId: mocks.connection.id,
    database: "test",
    tableName: "users",
  });
  mountedApps.push(app);
  app.mount(root);
  await vi.waitFor(
    () => {
      expect(root.textContent).toContain("structureEditor.noChanges");
    },
    { timeout: 3000 },
  );
  await settle();
  return root;
}

function renderedRowIndexes(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-column-row-index]")).map((row) => row.dataset.columnRowIndex ?? "");
}

function rowNameValues(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>("[data-column-name-input]")).map((input) => input.value);
}

function columnNameInput(root: HTMLElement, name: string): HTMLInputElement {
  const input = Array.from(root.querySelectorAll<HTMLInputElement>("[data-column-name-input]")).find((candidate) => candidate.value === name);
  expect(input).not.toBeUndefined();
  return input!;
}

async function renameColumn(root: HTMLElement, from: string, to: string) {
  const input = columnNameInput(root, from);
  input.value = to;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

async function typeColumnSearch(text: string) {
  const input = document.body.querySelector<HTMLInputElement>('input[placeholder="structureEditor.searchColumns"]');
  expect(input).not.toBeNull();
  input!.value = text;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

function typeTrigger(root: HTMLElement, modelValue: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-model-value]")).find((button) => button.dataset.modelValue === modelValue);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.executeQuery.mockResolvedValue({ columns: [], rows: [] });
  mocks.executeBatch.mockResolvedValue({ rowsAffected: 0 });
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.getTablePartitionStatus.mockResolvedValue({ isPartitionedParent: false, isPartition: false });
  mocks.getTableOwner.mockResolvedValue("");
  mocks.buildTableOwnerChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE users (id bigint)", cacheStatus: "remote" });
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("TableStructureEditor columns tab type coloring", () => {
  it("colors each type trigger with the grid's per-type palette class", async () => {
    const root = await mountEditor([
      { name: "id", data_type: "int", nullable: false },
      { name: "username", data_type: "varchar(255)" },
      { name: "created_at", data_type: "timestamp" },
      { name: "widget_ref", data_type: "widget_ref" },
    ]);

    expect(typeTrigger(root, "int")?.classList).toContain("data-grid-type-integer");
    expect(typeTrigger(root, "varchar")?.classList).toContain("data-grid-type-string");
    expect(typeTrigger(root, "timestamp")?.classList).toContain("data-grid-type-temporal");
    // Unknown types stay on the default foreground — no palette class.
    const unknown = typeTrigger(root, "widget_ref");
    expect(unknown).not.toBeUndefined();
    expect(Array.from(unknown!.classList).some((cls) => cls.startsWith("data-grid-type-"))).toBe(false);
  });
});

describe("TableStructureEditor columns tab search filter", () => {
  it("filters rows to matches, keeping pending-edited columns visible with their original position", async () => {
    const root = await mountEditor([
      { name: "id", data_type: "int", nullable: false },
      { name: "username", data_type: "varchar(255)" },
      { name: "created_at", data_type: "timestamp" },
      { name: "legacy_note", data_type: "varchar(255)" },
    ]);

    expect(renderedRowIndexes(root)).toEqual(["0", "1", "2", "3"]);

    // A pending rename makes the column "changed"; the new name does not match
    // the query below, but the row must stay visible regardless.
    await renameColumn(root, "legacy_note", "oldstuff");

    await typeColumnSearch("user");

    expect(renderedRowIndexes(root)).toEqual(["1", "3"]);
    expect(rowNameValues(root)).toEqual(["username", "oldstuff"]);

    await typeColumnSearch("created");

    expect(renderedRowIndexes(root)).toEqual(["2", "3"]);
    expect(rowNameValues(root)).toEqual(["created_at", "oldstuff"]);
  });

  it("shows an empty state when nothing matches and no row has pending edits", async () => {
    const root = await mountEditor([
      { name: "id", data_type: "int", nullable: false },
      { name: "username", data_type: "varchar(255)" },
    ]);

    await typeColumnSearch("zzz");

    expect(root.querySelectorAll("[data-column-row-index]")).toHaveLength(0);
    expect(root.textContent).toContain("structureEditor.columnSearchNoMatches");
  });

  it("clearing the query restores all rows", async () => {
    const root = await mountEditor([
      { name: "id", data_type: "int", nullable: false },
      { name: "username", data_type: "varchar(255)" },
    ]);

    await typeColumnSearch("id");
    expect(renderedRowIndexes(root)).toEqual(["0"]);

    await typeColumnSearch("");
    expect(renderedRowIndexes(root)).toEqual(["0", "1"]);
  });

  it("Escape clears the filter", async () => {
    const root = await mountEditor([
      { name: "id", data_type: "int", nullable: false },
      { name: "username", data_type: "varchar(255)" },
    ]);

    await typeColumnSearch("id");
    expect(renderedRowIndexes(root)).toEqual(["0"]);

    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="structureEditor.searchColumns"]')!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();

    expect(renderedRowIndexes(root)).toEqual(["0", "1"]);
    expect(input.value).toBe("");
  });

  it("the ✕ button clears the filter", async () => {
    const root = await mountEditor([
      { name: "id", data_type: "int", nullable: false },
      { name: "username", data_type: "varchar(255)" },
    ]);

    await typeColumnSearch("user");
    expect(renderedRowIndexes(root)).toEqual(["1"]);

    const clear = root.querySelector<HTMLButtonElement>('[aria-label="structureEditor.clearColumnFilter"]');
    expect(clear).not.toBeNull();
    clear!.click();
    await settle();

    expect(renderedRowIndexes(root)).toEqual(["0", "1"]);
  });
});
