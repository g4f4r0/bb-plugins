import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { ArtifactDirective } from "./components/artifact-card.js";
import { COMPUTER_PANEL_PATH, ComputerPanel } from "./components/computer-panel.js";

export const ARTIFACT_DIRECTIVE_ID = "wayfinder-artifact";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "computer",
    title: "Computer",
    icon: "Monitor",
    path: COMPUTER_PANEL_PATH,
    component: ComputerPanel,
  });
  // Agents reference evidence as ::wayfinder-artifact{id="art_…"} in replies.
  app.slots.messageDirective({ id: ARTIFACT_DIRECTIVE_ID, component: ArtifactDirective });
});
