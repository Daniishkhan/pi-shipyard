import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerReviewFindings from "./review-findings.ts";
import registerWorkflows from "./workflows.ts";

export default function piShipyard(pi: ExtensionAPI) {
	registerReviewFindings(pi);
	registerWorkflows(pi);
}
