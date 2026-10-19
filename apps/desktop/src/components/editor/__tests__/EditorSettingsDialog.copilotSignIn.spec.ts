import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");

describe("EditorSettingsDialog GitHub Copilot sign-in", () => {
  it("replaces the API key row with a device-flow sign-in card for copilot", () => {
    expect(dialogSource).toContain('v-if="!aiIsCcSwitchProvider && !aiIsCliProvider && !aiIsGithubCopilot"');
    expect(dialogSource).toContain('v-if="aiIsGithubCopilot"');
    expect(dialogSource).toContain('const aiIsGithubCopilot = computed(() => aiEditProvider.value === "github-copilot");');
    expect(dialogSource).toContain('@click="copilotStartSignIn"');
  });

  it("drives the device flow through the backend commands", () => {
    expect(dialogSource).toContain("await copilotDeviceStart()");
    expect(dialogSource).toContain("copilotDevicePoll(deviceCode, copilotSignInIntervalSecs.value)");
    expect(dialogSource).toContain("copilotCurrentUser(accessToken)");
    // The gho_ token rides the existing API key field, so saving needs no new plumbing.
    expect(dialogSource).toContain("aiEditApiKey.value = result.accessToken;");
  });

  it("stops polling when the dialog closes or the provider changes", () => {
    expect(dialogSource).toContain("watch(settingsVisible, (visible) => {");
    expect(dialogSource).toContain("if (!visible) copilotSuspendSignIn();");
    expect(dialogSource).toMatch(/function aiSelectProvider[\s\S]{0,400}copilotResetSignInState\(\);/);
  });

  it("keeps sign-out local and surfaces the login name", () => {
    expect(dialogSource).toContain('@click="copilotSignOut"');
    expect(dialogSource).toContain('t("ai.copilotSignedInAs", { login: copilotSignInLogin })');
  });
});
