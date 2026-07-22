import assert from "node:assert/strict";
import test from "node:test";
import { completeWorkflowModes, normalizeWorkflowName, parseShipyardCommand } from "../extensions/workflow-names.ts";

test("normalizes canonical and legacy workflow names", () => {
	assert.equal(normalizeWorkflowName("explore"), "explore");
	assert.equal(normalizeWorkflowName(" REVIEW "), "review");
	assert.equal(normalizeWorkflowName("review-fast"), "fast");
	assert.equal(normalizeWorkflowName("review-mesh"), "review");
	assert.equal(normalizeWorkflowName("review-security"), "security");
	assert.equal(normalizeWorkflowName("review-ui"), "ui");
	assert.equal(normalizeWorkflowName("unknown"), undefined);
});

test("parses one shipyard command mode and preserves the remaining task", () => {
	assert.deepEqual(parseShipyardCommand(""), {});
	assert.deepEqual(parseShipyardCommand("debug"), { workflow: "debug", mode: "debug", task: undefined });
	assert.deepEqual(parseShipyardCommand(" explore   trace auth callers "), {
		workflow: "explore",
		mode: "explore",
		task: "trace auth callers",
	});
	assert.deepEqual(parseShipyardCommand("nope task"), { workflow: undefined, mode: "nope", task: "task" });
});

test("mode completion stops after task-separating whitespace", () => {
	assert.deepEqual(completeWorkflowModes("rev"), ["review"]);
	assert.deepEqual(completeWorkflowModes("  deb"), ["debug"]);
	assert.equal(completeWorkflowModes("review "), null);
	assert.equal(completeWorkflowModes("debug\t"), null);
	assert.equal(completeWorkflowModes("unknown"), null);
});
