import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { initializeStore } from "./findings-store.ts";
import { createCapabilityRegistry, type CapabilityPolicy, type FindingUpdateField } from "./findings-capabilities.ts";
import { ShipyardRpcClient, type RpcReply } from "./rpc-client.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIPYARD_RUNS_ROOT = path.join(getAgentDir(), "shipyard-runs");
const RPC_REPLY_TIMEOUT_MS = 15_000;

const WORKFLOWS = {
	"review-mesh": { file: "review-mesh.chain.json", timeoutMs: 45 * 60_000 },
	"review-fast": { file: "review-fast.chain.json", timeoutMs: 20 * 60_000 },
	"review-security": { file: "review-security.chain.json", timeoutMs: 60 * 60_000 },
	"review-ui": { file: "review-ui.chain.json", timeoutMs: 60 * 60_000 },
	deliver: { file: "deliver.chain.json", timeoutMs: 120 * 60_000 },
	ship: { file: "ship.chain.json", timeoutMs: 90 * 60_000 },
} as const;

type WorkflowName = keyof typeof WORKFLOWS;

interface WorkflowFile {
	name: string;
	description: string;
	chain: Array<Record<string, unknown>>;
}

const WorkflowParams = Type.Object({
	workflow: StringEnum(Object.keys(WORKFLOWS) as WorkflowName[]),
	task: Type.Optional(Type.String({ maxLength: 32_768, description: "Review, implementation, or shipping target" })),
}, { additionalProperties: false });

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function safePart(prefix: "S" | "R", value: string): string {
	const normalized = value.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
	return `${prefix}-${normalized}`;
}

function replacePlaceholders(value: unknown, replacements: Record<string, string>): unknown {
	if (typeof value === "string") {
		let output = value;
		for (const [placeholder, replacement] of Object.entries(replacements)) output = output.replaceAll(placeholder, replacement);
		return output;
	}
	if (Array.isArray(value)) return value.map((entry) => replacePlaceholders(entry, replacements));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, replacePlaceholders(entry, replacements)]));
	}
	return value;
}

async function loadWorkflow(name: WorkflowName): Promise<WorkflowFile> {
	const filePath = path.join(PACKAGE_ROOT, "chains", WORKFLOWS[name].file);
	const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<WorkflowFile>;
	if (!parsed || typeof parsed.name !== "string" || typeof parsed.description !== "string" || !Array.isArray(parsed.chain)) {
		throw new Error(`Invalid Shipyard workflow file: ${filePath}`);
	}
	return parsed as WorkflowFile;
}

const FIRST_WAVE_OUTPUTS = new Set(["contracts", "runtime", "adversarial", "integration", "security", "ui"]);
const ALL_UPDATE_FIELDS: FindingUpdateField[] = ["title", "summary", "severity", "confidence", "status", "category", "evidence", "failureScenario", "suggestedFix", "validation", "dispositionReason", "tags"];

function findingStage(task: Record<string, unknown>): string {
	const text = typeof task.task === "string" ? task.task : "";
	const explicit = text.match(/(?:creation )?stage\s+`([^`]+)`/i)?.[1]?.trim();
	return explicit || (typeof task.as === "string" ? task.as : "workflow");
}

function capabilityPolicy(task: Record<string, unknown>): CapabilityPolicy | undefined {
	const agent = typeof task.agent === "string" ? task.agent : "";
	const output = typeof task.as === "string" ? task.as : "";
	if (!agent || agent.endsWith(".codebase-reader") || agent.endsWith(".delivery-planner")) return undefined;
	const base = { stage: findingStage(task), sourceRole: agent };
	if (FIRST_WAVE_OUTPUTS.has(output)) return { ...base, actions: ["init", "add"] };
	if (agent.endsWith(".falsifier")) return {
		...base,
		actions: ["init", "get", "list", "update", "stats", "snapshot"],
		updateFields: ALL_UPDATE_FIELDS,
		updateStatuses: ["verified", "rejected", "deferred"],
	};
	if (agent.endsWith(".blindspot-hunter")) return {
		...base,
		actions: ["init", "add", "get", "list", "update", "stats", "snapshot"],
		updateFields: ["confidence", "evidence", "validation", "tags"],
	};
	if (agent.endsWith(".review-synthesizer")) return {
		...base,
		actions: ["init", "get", "list", "update", "stats", "snapshot", "export"],
		updateFields: ALL_UPDATE_FIELDS,
		updateStatuses: ["verified", "rejected", "deferred", "resolved"],
	};
	if (agent.endsWith(".implementation-worker")) return {
		...base,
		actions: ["init", "get", "list", "update", "stats"],
		updateFields: ["status", "suggestedFix", "validation", "dispositionReason", "tags"],
		updateStatuses: ["resolved", "deferred"],
	};
	if (agent.endsWith(".shipwright")) return {
		...base,
		actions: ["init", "add", "get", "list", "update", "stats", "snapshot", "export"],
		updateFields: ALL_UPDATE_FIELDS,
		updateStatuses: ["verified", "rejected", "deferred", "resolved"],
	};
	return {
		...base,
		actions: ["init", "add", "get", "list", "update", "stats"],
		updateFields: ["confidence", "status", "evidence", "validation", "dispositionReason", "tags"],
		updateStatuses: ["verified", "rejected", "deferred", "resolved"],
	};
}

function collectCapabilityTasks(chain: Array<Record<string, unknown>>): Array<{ task: Record<string, unknown>; policy: CapabilityPolicy }> {
	const collected: Array<{ task: Record<string, unknown>; policy: CapabilityPolicy }> = [];
	const visit = (task: Record<string, unknown>) => {
		const parallel = Array.isArray(task.parallel) ? task.parallel as Array<Record<string, unknown>> : [];
		for (const child of parallel) visit(child);
		const policy = capabilityPolicy(task);
		if (policy) collected.push({ task, policy });
	};
	for (const step of chain) visit(step);
	return collected;
}

function redactCapabilities(value: unknown, tokens: string[]): unknown {
	let serialized = JSON.stringify(value);
	for (const token of tokens) serialized = serialized.replaceAll(token, "[redacted-findings-capability]");
	return JSON.parse(serialized);
}

function defaultWorkflowTask(name: WorkflowName): string {
	switch (name) {
		case "review-mesh":
			return "Review the current worktree diff against the user request, repository instructions, and existing behavior.";
		case "review-fast":
			return "Run a focused bug review of the current worktree diff.";
		case "review-security":
			return "Review the current worktree diff for correctness and security boundary failures.";
		case "review-ui":
			return "Review the current UI worktree diff for behavior, state-flow, accessibility, interaction, and visual regressions.";
		case "deliver":
			return "Implement the currently discussed approved task, review it, apply verified fixes, validate it, and prepare a delivery handoff.";
		case "ship":
			return "Review, fix, validate, and prepare the current worktree changes for shipment. Do not commit or push.";
	}
}

export default function registerWorkflows(pi: ExtensionAPI) {
	const rpc = new ShipyardRpcClient(pi.events, RPC_REPLY_TIMEOUT_MS);
	pi.on("session_shutdown", () => rpc.dispose());

	async function createRun(ctx: ExtensionContext, name: WorkflowName, workflow: WorkflowFile): Promise<{
		runId: string;
		runDir: string;
		storePath: string;
		chain: Array<Record<string, unknown>>;
	}> {
		const sessionId = ctx.sessionManager.getSessionId() ?? `ephemeral-${randomUUID().slice(0, 8)}`;
		const sessionDir = safePart("S", sessionId);
		const runId = safePart("R", `${Date.now().toString(36)}-${randomUUID().slice(0, 12)}`);
		const runDir = path.join(SHIPYARD_RUNS_ROOT, sessionDir, runId);
		const storePath = path.join(runDir, "findings");
		await mkdir(storePath, { recursive: true, mode: 0o700 });
		await initializeStore(storePath, { runId, workflow: name });
		const chain = replacePlaceholders(workflow.chain, {
			"{{SHIPYARD_RUN_ID}}": runId,
			"{{SHIPYARD_RUN_DIR}}": runDir,
			"{{SHIPYARD_STORE}}": storePath,
		}) as Array<Record<string, unknown>>;
		const capabilityTasks = collectCapabilityTasks(chain);
		const grants = await createCapabilityRegistry(storePath, runId, name, capabilityTasks.map((entry) => entry.policy));
		for (let index = 0; index < capabilityTasks.length; index += 1) {
			const task = capabilityTasks[index].task;
			const token = grants[index].token;
			const instruction = `Findings capability: ${token}. Pass it exactly as the capability parameter on every review_findings call. Never copy it into an artifact or finding.`;
			task.task = `${String(task.task ?? "").trimEnd()}\n\n${instruction}`;
		}
		await writeFile(path.join(runDir, "workflow.json"), `${JSON.stringify({
			schemaVersion: 1,
			runId,
			workflow: name,
			description: workflow.description,
			cwd: ctx.cwd,
			createdAt: new Date().toISOString(),
			chain: redactCapabilities(chain, grants.map((grant) => grant.token)),
		}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		return { runId, runDir, storePath, chain };
	}

	async function spawnWorkflow(ctx: ExtensionContext, name: WorkflowName, task?: string, signal?: AbortSignal): Promise<{
		message: string;
		shipyardRunId: string;
		runDir: string;
		storePath: string;
		rpc: RpcReply["data"];
	}> {
		const ping = await rpc.request("ping", {}, signal);
		if (!ping.success) throw new Error(`${ping.error?.code ?? "rpc_error"}: ${ping.error?.message ?? "pi-subagents RPC ping failed."}`);
		if (signal?.aborted) throw new Error("Shipyard workflow cancelled after RPC readiness check.");
		const workflow = await loadWorkflow(name);
		if (signal?.aborted) throw new Error("Shipyard workflow cancelled before run creation.");
		const run = await createRun(ctx, name, workflow);
		if (signal?.aborted) {
			await rm(run.runDir, { recursive: true, force: true });
			throw new Error("Shipyard workflow cancelled before subagent spawn.");
		}
		const target = task?.trim() || defaultWorkflowTask(name);
		const launchPath = path.join(run.runDir, "launch.json");
		const launchBase = {
			schemaVersion: 1,
			shipyardRunId: run.runId,
			workflow: name,
			task: target,
			requestedAt: new Date().toISOString(),
		};
		await writeFile(launchPath, `${JSON.stringify({ ...launchBase, state: "requesting", rpc: null }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		let abortedDuringSpawn = false;
		const onAbort = () => { abortedDuringSpawn = true; };
		signal?.addEventListener("abort", onAbort, { once: true });
		let reply: RpcReply;
		try {
			reply = await rpc.request("spawn", {
				chain: run.chain,
				task: target,
				cwd: ctx.cwd,
				context: "fresh",
				async: true,
				clarify: false,
				artifacts: true,
				maxRuntimeMs: WORKFLOWS[name].timeoutMs,
			});
		} catch (error) {
			await writeFile(launchPath, `${JSON.stringify({
				...launchBase,
				state: "launch-uncertain",
				failedAt: new Date().toISOString(),
				error: error instanceof Error ? error.message : String(error),
				recovery: "Inspect pi-subagents async status; the spawn request may have been accepted before the RPC reply was lost.",
			}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
		if (!reply.success) {
			await writeFile(launchPath, `${JSON.stringify({ ...launchBase, state: "rejected", failedAt: new Date().toISOString(), rpc: reply }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			throw new Error(`${reply.error?.code ?? "rpc_error"}: ${reply.error?.message ?? "Shipyard workflow launch failed."}`);
		}
		if (abortedDuringSpawn || signal?.aborted) {
			const runId = typeof reply.data?.details?.runId === "string"
				? reply.data.details.runId
				: typeof reply.data?.details?.asyncId === "string"
					? reply.data.details.asyncId
					: undefined;
			let stopRequested = false;
			if (runId) stopRequested = await rpc.request("stop", { id: runId }).then((stop) => stop.success, () => false);
			await writeFile(launchPath, `${JSON.stringify({
				...launchBase,
				state: stopRequested ? "cancellation-requested" : "cancellation-uncertain",
				cancelledAt: new Date().toISOString(),
				rpc: reply.data ?? null,
				stopRequested,
			}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			throw new Error(runId
				? `Shipyard workflow cancelled after spawn acknowledgement; ${stopRequested ? "stop requested" : "stop could not be confirmed"} for ${runId}.`
				: "Shipyard workflow cancelled after spawn acknowledgement; inspect active subagents because no run id was returned.");
		}
		await writeFile(launchPath, `${JSON.stringify({
			...launchBase,
			state: "launched",
			launchedAt: new Date().toISOString(),
			rpc: reply.data ?? null,
		}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		const rpcText = reply.data?.text?.trim() || `Launched Shipyard workflow ${name}.`;
		return {
			message: `${rpcText}\nShipyard run: ${run.runId}\nLedger: ${run.storePath}`,
			shipyardRunId: run.runId,
			runDir: run.runDir,
			storePath: run.storePath,
			rpc: reply.data,
		};
	}

	function registerWorkflowCommand(command: string, workflow: WorkflowName, description: string): void {
		pi.registerCommand(command, {
			description,
			handler: async (args, ctx) => {
				try {
					const launched = await spawnWorkflow(ctx, workflow, args);
					ctx.ui.notify(launched.message, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	}

	pi.registerTool({
		name: "shipyard_workflow",
		label: "Shipyard Workflow",
		description: "Launch a deterministic asynchronous Shipyard workflow through the installed pi-subagents RPC. Use review-fast for a small change, review-mesh for deep review, review-security for trust-boundary changes, review-ui for UI work, deliver for an approved implementation, and ship for review/fix/validation of an existing diff. Shipyard never commits or pushes automatically.",
		parameters: WorkflowParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("shipyard_workflow cancelled");
			const launched = await spawnWorkflow(ctx, params.workflow as WorkflowName, params.task, signal);
			return textResult(launched.message, launched);
		},
	});

	registerWorkflowCommand("shipyard-review", "review-mesh", "Deep staged review with independent discovery, falsification, blind-spot hunting, and compact synthesis");
	registerWorkflowCommand("shipyard-review-fast", "review-fast", "Focused two-angle bug review with compact adjudication");
	registerWorkflowCommand("shipyard-review-security", "review-security", "Security-sensitive staged review mesh");
	registerWorkflowCommand("shipyard-review-ui", "review-ui", "UI behavior, state-flow, accessibility, and interaction review mesh");
	registerWorkflowCommand("shipyard-deliver", "deliver", "Read, plan, implement, review, fix, validate, and prepare a delivery handoff");
	registerWorkflowCommand("shipyard-ship", "ship", "Review and fix existing work, revalidate it, and prepare a shipping handoff without commit/push");

	// Familiar aliases. The packaged pi-subagents /parallel-review prompt is filtered during installation.
	registerWorkflowCommand("parallel-review", "review-mesh", "Shipyard deep review mesh");
	registerWorkflowCommand("review-fast", "review-fast", "Shipyard focused review");
	registerWorkflowCommand("review-security", "review-security", "Shipyard security review");
	registerWorkflowCommand("review-ui", "review-ui", "Shipyard UI review");
	registerWorkflowCommand("deliver", "deliver", "Shipyard agentic delivery workflow");
	registerWorkflowCommand("ship", "ship", "Shipyard shipping-readiness workflow");

	pi.registerCommand("shipyard", {
		description: "List Shipyard workflow commands",
		handler: async (_args, ctx) => {
			ctx.ui.notify([
				"Shipyard workflows:",
				"/shipyard-review-fast [target]",
				"/shipyard-review [target] (alias: /parallel-review)",
				"/shipyard-review-security [target]",
				"/shipyard-review-ui [target]",
				"/shipyard-deliver [approved implementation task]",
				"/shipyard-ship [existing diff; never commits or pushes automatically]",
			].join("\n"), "info");
		},
	});
}
