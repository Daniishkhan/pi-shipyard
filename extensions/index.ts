import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerRepoContext from "./repo-context.ts";
import registerReviewFindings from "./review-findings.ts";
import registerWorkflows from "./workflows.ts";

export default function piShipyard(pi: ExtensionAPI) {
	registerRepoContext(pi);
	registerReviewFindings(pi);
	registerWorkflows(pi);
}
