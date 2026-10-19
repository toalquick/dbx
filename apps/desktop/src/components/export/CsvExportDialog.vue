<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DEFAULT_CSV_DELIMITER, DEFAULT_CSV_QUOTE_CHAR, type CsvQuoteMode, type CsvTextFormatOptions } from "@/lib/export/csvQuoteMode";

type DelimiterChoice = "comma" | "semicolon" | "tab" | "pipe" | "custom";
type QuoteCharChoice = "double" | "single" | "backtick" | "custom";

const DELIMITER_VALUES: Record<Exclude<DelimiterChoice, "custom">, string> = {
  comma: ",",
  semicolon: ";",
  tab: "\t",
  pipe: "|",
};

const QUOTE_CHAR_VALUES: Record<Exclude<QuoteCharChoice, "custom">, string> = {
  double: '"',
  single: "'",
  backtick: "`",
};

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{ defaultQuoteMode?: CsvQuoteMode }>();
const quoteMode = ref<CsvQuoteMode>(props.defaultQuoteMode ?? "all");
const delimiterChoice = ref<DelimiterChoice>("comma");
const customDelimiter = ref("");
const quoteCharChoice = ref<QuoteCharChoice>("double");
const customQuoteChar = ref("");
const includeHeader = ref(true);
let outcomeEmitted = false;

const emit = defineEmits<{
  confirm: [options: CsvTextFormatOptions];
  cancel: [];
}>();

const delimiterValid = computed(() => delimiterChoice.value !== "custom" || customDelimiter.value.length > 0);
const quoteCharValid = computed(() => quoteCharChoice.value !== "custom" || customQuoteChar.value.length > 0);
const canConfirm = computed(() => delimiterValid.value && quoteCharValid.value);

function onConfirm() {
  if (!canConfirm.value) return;
  outcomeEmitted = true;
  open.value = false;
  emit("confirm", {
    quoteMode: quoteMode.value,
    delimiter: delimiterChoice.value === "custom" ? (customDelimiter.value[0] ?? DEFAULT_CSV_DELIMITER) : DELIMITER_VALUES[delimiterChoice.value],
    quoteChar: quoteCharChoice.value === "custom" ? (customQuoteChar.value[0] ?? DEFAULT_CSV_QUOTE_CHAR) : QUOTE_CHAR_VALUES[quoteCharChoice.value],
    includeHeader: includeHeader.value,
  });
}

function onCancel() {
  if (outcomeEmitted) return;
  outcomeEmitted = true;
  open.value = false;
  emit("cancel");
}

function onOpenChange(value: boolean) {
  if (!value) onCancel();
}
</script>

<template>
  <Dialog v-model:open="open" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-md" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("grid.csvExportTitle") }}</DialogTitle>
      </DialogHeader>
      <form class="space-y-3 py-2" @submit.prevent="onConfirm">
        <p class="text-sm text-muted-foreground">{{ t("grid.csvExportPrompt") }}</p>
        <label class="flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors hover:bg-accent/50">
          <input v-model="quoteMode" type="radio" value="all" class="mt-0.5 h-4 w-4 shrink-0" data-csv-quote-mode="all" />
          <span class="min-w-0">
            <span class="block text-sm font-medium">{{ t("grid.csvExportQuoteModeAll") }}</span>
            <span class="mt-1 block text-xs text-muted-foreground">{{ t("grid.csvExportQuoteModeAllDescription") }}</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors hover:bg-accent/50">
          <input v-model="quoteMode" type="radio" value="necessary" class="mt-0.5 h-4 w-4 shrink-0" data-csv-quote-mode="necessary" />
          <span class="min-w-0">
            <span class="block text-sm font-medium">{{ t("grid.csvExportQuoteModeNecessary") }}</span>
            <span class="mt-1 block text-xs text-muted-foreground">{{ t("grid.csvExportQuoteModeNecessaryDescription") }}</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors hover:bg-accent/50">
          <input v-model="quoteMode" type="radio" value="strings" class="mt-0.5 h-4 w-4 shrink-0" data-csv-quote-mode="strings" />
          <span class="min-w-0">
            <span class="block text-sm font-medium">{{ t("grid.csvExportQuoteModeStrings") }}</span>
            <span class="mt-1 block text-xs text-muted-foreground">{{ t("grid.csvExportQuoteModeStringsDescription") }}</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors hover:bg-accent/50">
          <input v-model="quoteMode" type="radio" value="never" class="mt-0.5 h-4 w-4 shrink-0" data-csv-quote-mode="never" />
          <span class="min-w-0">
            <span class="block text-sm font-medium">{{ t("grid.csvExportQuoteModeNever") }}</span>
            <span class="mt-1 block text-xs text-muted-foreground">{{ t("grid.csvExportQuoteModeNeverDescription") }}</span>
          </span>
        </label>
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground" for="csv-delimiter">{{ t("grid.csvExportDelimiter") }}</label>
            <select id="csv-delimiter" v-model="delimiterChoice" class="h-8 w-full rounded-md border bg-background px-2 text-sm" data-csv-delimiter>
              <option value="comma">{{ t("grid.csvExportDelimiterComma") }}</option>
              <option value="semicolon">{{ t("grid.csvExportDelimiterSemicolon") }}</option>
              <option value="tab">{{ t("grid.csvExportDelimiterTab") }}</option>
              <option value="pipe">{{ t("grid.csvExportDelimiterPipe") }}</option>
              <option value="custom">{{ t("grid.csvExportDelimiterCustom") }}</option>
            </select>
            <input v-if="delimiterChoice === 'custom'" v-model="customDelimiter" type="text" maxlength="1" class="h-8 w-full rounded-md border bg-background px-2 text-sm" :placeholder="t('grid.csvExportCustomDelimiterPlaceholder')" data-csv-custom-delimiter />
          </div>
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground" for="csv-quote-char">{{ t("grid.csvExportQuoteChar") }}</label>
            <select id="csv-quote-char" v-model="quoteCharChoice" class="h-8 w-full rounded-md border bg-background px-2 text-sm" data-csv-quote-char>
              <option value="double">{{ t("grid.csvExportQuoteCharDouble") }}</option>
              <option value="single">{{ t("grid.csvExportQuoteCharSingle") }}</option>
              <option value="backtick">{{ t("grid.csvExportQuoteCharBacktick") }}</option>
              <option value="custom">{{ t("grid.csvExportQuoteCharCustom") }}</option>
            </select>
            <input v-if="quoteCharChoice === 'custom'" v-model="customQuoteChar" type="text" maxlength="1" class="h-8 w-full rounded-md border bg-background px-2 text-sm" :placeholder="t('grid.csvExportCustomQuoteCharPlaceholder')" data-csv-custom-quote-char />
          </div>
        </div>
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input v-model="includeHeader" type="checkbox" class="h-4 w-4" data-csv-include-header />
          {{ t("grid.csvExportIncludeHeader") }}
        </label>
        <DialogFooter>
          <Button variant="outline" @click="onCancel">{{ t("common.cancel") }}</Button>
          <Button type="submit" :disabled="!canConfirm" data-csv-export-confirm>{{ t("common.confirm") }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
