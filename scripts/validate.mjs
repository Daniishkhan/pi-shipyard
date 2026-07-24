import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warnings = [];

function fail(message) {
	errors.push(message);
}

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		fail(`${path.relative(root, file)}: invalid JSON: ${error.message}`);
		return null;
	}
}

function parseFrontmatter(file) {
	const text = readFileSync(file, "utf8");
	const match = text.match(/^---\n([\s\S]*?)\n---\n/);
	if (!match) {
		fail(`${path.relative(root, file)}: missing YAML frontmatter`);
		return {};
	}
	const values = {};
	for (const line of match[1].split("\n")) {
		const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
		if (field) values[field[1]] = field[2] ?? "";
	}
	return values;
}

const packageJson = readJson(path.join(root, "package.json"));
if (packageJson) {
	if (!packageJson.keywords?.includes("pi-package")) fail("package.json: keywords must include pi-package");
	for (const [kind, entries] of Object.entries({
		extensions: packageJson.pi?.extensions,
		skills: packageJson.pi?.skills,
		prompts: packageJson.pi?.prompts,
		agents: packageJson.pi?.subagents?.agents,
		chains: packageJson.pi?.subagents?.chains,
	})) {
		if (!Array.isArray(entries) || entries.length === 0) fail(`package.json: pi manifest missing ${kind}`);
		for (const entry of entries ?? []) {
			if (!existsSync(path.resolve(root, entry))) fail(`package.json: declared ${kind} path does not exist: ${entry}`);
		}
	}
}

const agentDir = path.join(root, "agents");
const agentFiles = readdirSync(agentDir).filter((name) => name.endsWith(".md")).sort();
const agentNames = new Set();
for (const name of agentFiles) {
	const file = path.join(agentDir, name);
	const fm = parseFrontmatter(file);
	if (!fm.name) fail(`agents/${name}: missing name`);
	if (!fm.description) fail(`agents/${name}: missing description`);
	if (fm.package !== "pi-shipyard") fail(`agents/${name}: package must be pi-shipyard`);
	const runtimeName = `${fm.package}.${fm.name}`;
	if (agentNames.has(runtimeName)) fail(`agents/${name}: duplicate runtime name ${runtimeName}`);
	agentNames.add(runtimeName);
	if (fm.acceptanceRole === "read-only" && /\bedit\b|\bwrite\b/.test(fm.tools ?? "")) {
		fail(`agents/${name}: read-only agent exposes edit/write`);
	}
	if (fm.acceptanceRole === "read-only" && /\bbash\b/.test(fm.tools ?? "")) {
		fail(`agents/${name}: review/read-only agents must use shipyard_repo instead of unrestricted bash`);
	}
	if (fm.acceptanceRole === "read-only" && !(fm.tools ?? "").includes("shipyard_repo")) {
		fail(`agents/${name}: read-only agent must expose shipyard_repo for safe Git inspection`);
	}
	if ((fm.tools ?? "").includes("review_findings")) {
		if (Object.hasOwn(fm, "extensions")) fail(`agents/${name}: findings agents must leave extensions omitted so the installed package provider loads`);
		if (Object.hasOwn(fm, "subagentOnlyExtensions")) fail(`agents/${name}: package-relative child extension paths are not portable in this runtime`);
	}
}

const skillDir = path.join(root, "skills");
const skillNames = new Set();
for (const directory of readdirSync(skillDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
	const file = path.join(skillDir, directory.name, "SKILL.md");
	if (!existsSync(file)) {
		fail(`skills/${directory.name}: missing SKILL.md`);
		continue;
	}
	const fm = parseFrontmatter(file);
	if (!fm.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fm.name)) fail(`skills/${directory.name}: invalid or missing skill name`);
	if (!fm.description) fail(`skills/${directory.name}: missing description`);
	if (skillNames.has(fm.name)) fail(`skills/${directory.name}: duplicate skill name ${fm.name}`);
	skillNames.add(fm.name);
}

for (const name of agentFiles) {
	const fm = parseFrontmatter(path.join(agentDir, name));
	for (const skill of (fm.skills ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
		if (!skillNames.has(skill)) fail(`agents/${name}: unknown selected skill ${skill}`);
	}
}

const workflowsSource = readFileSync(path.join(root, "extensions", "workflows.ts"), "utf8");
if (!workflowsSource.includes("artifacts: false") || workflowsSource.includes("artifacts: true")) {
	fail("extensions/workflows.ts: Shipyard RPC launches must disable project-local pi-subagents artifacts");
}

const outputReferencePattern = /\{outputs\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
const allowedStepKeys = new Set([
	"agent", "task", "phase", "label", "as", "outputSchema", "cwd", "output", "outputMode", "reads", "progress",
	"skill", "model", "toolBudget", "acceptance", "parallel", "expand", "collect", "concurrency", "failFast", "worktree",
]);
const allowedParallelTaskKeys = new Set([
	"agent", "task", "phase", "label", "as", "outputSchema", "cwd", "count", "output", "outputMode", "reads", "progress",
	"skill", "model", "toolBudget", "acceptance",
]);

function inspectTask(chainFile, stepNumber, task, available, produced, isParallel = false) {
	const prefix = `${chainFile} step ${stepNumber}${isParallel ? " parallel task" : ""}`;
	const allowed = isParallel ? allowedParallelTaskKeys : allowedStepKeys;
	for (const key of Object.keys(task)) if (!allowed.has(key)) fail(`${prefix}: unsupported key ${key}`);
	if (!task.agent || !agentNames.has(task.agent)) fail(`${prefix}: unknown agent ${task.agent}`);
	if (typeof task.task !== "string" || !task.task.trim()) fail(`${prefix}: task must be non-empty`);
	const outputReferences = [...(task.task?.matchAll(outputReferencePattern) ?? [])];
	for (const match of outputReferences) {
		if (!available.has(match[1])) fail(`${prefix}: forward or unknown output reference ${match[1]}`);
	}
	if (outputReferences.length > 0 && !task.task.includes("Open and read every referenced output artifact before reasoning")) {
		fail(`${prefix}: file-only output consumer must explicitly open and read every referenced artifact`);
	}
	if (["contracts", "runtime", "adversarial", "integration", "security", "ui"].includes(task.as ?? "")
		&& !task.task.includes("Independent-wave rule: do not call review_findings list")) {
		fail(`${prefix}: first-wave reviewer must explicitly prohibit peer-ledger reads`);
	}
	const postReviewAgent = ["pi-shipyard.contract-reviewer", "pi-shipyard.runtime-reviewer", "pi-shipyard.adversarial-tester"].includes(task.agent);
	const addCapable = ["contracts", "runtime", "adversarial", "integration", "security", "ui", "blindspots"].includes(task.as ?? "")
		|| ((task.as ?? "").startsWith("post") && postReviewAgent)
		|| task.agent === "pi-shipyard.shipwright";
	if (addCapable) {
		const stageMarkers = [...task.task.matchAll(/(?:creation )?stage\s+`([^`]+)`/gi)];
		if (stageMarkers.length !== 1) fail(`${prefix}: add-capable task must contain exactly one explicit stage marker`);
	}
	if (task.as) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(task.as)) fail(`${prefix}: invalid as name ${task.as}`);
		if (available.has(task.as) || produced.has(task.as)) fail(`${prefix}: duplicate as name ${task.as}`);
		produced.add(task.as);
	}
	if (task.outputMode === "file-only" && typeof task.output !== "string") fail(`${prefix}: file-only requires an output path`);
	if (typeof task.output === "string" && path.isAbsolute(task.output)) fail(`${prefix}: output paths must remain runtime-managed relative paths`);
	if (task.outputSchema && task.outputMode === "file-only") fail(`${prefix}: do not combine outputSchema with file-only handoff`);
	if (task.task?.includes("{chain_dir}")) fail(`${prefix}: async RPC workflows must not rely on {chain_dir}`);
}

function validateDeliveryTopology(chain, name) {
	const implementationIndex = chain.chain.findIndex((step) => step.agent === "pi-shipyard.implementation-worker" && step.as === "implementation");
	const reviewIndex = chain.chain.findIndex((step) => Array.isArray(step.parallel));
	const falsifierIndex = chain.chain.findIndex((step) => step.agent === "pi-shipyard.falsifier");
	const fixesIndex = chain.chain.findIndex((step) => step.agent === "pi-shipyard.implementation-worker" && step.as === "fixes");
	const finalIndex = chain.chain.length - 1;
	const final = chain.chain[finalIndex];
	const ordered = implementationIndex >= 0 && implementationIndex < reviewIndex && reviewIndex < falsifierIndex
		&& falsifierIndex < fixesIndex && fixesIndex < finalIndex;
	if (!ordered) fail(`chains/${name}: delivery topology must be implementation -> independent review -> falsifier -> fixes -> final validation`);
	const reviewers = reviewIndex >= 0 ? chain.chain[reviewIndex].parallel : undefined;
	if (!Array.isArray(reviewers) || reviewers.length !== 2) fail(`chains/${name}: delivery must use exactly two independent reviewers`);
	const writers = chain.chain.filter((step) => step.agent === "pi-shipyard.implementation-worker");
	if (writers.length !== 2 || writers.some((step) => !["implementation", "fixes"].includes(step.as))) {
		fail(`chains/${name}: delivery must serialize exactly the initial and fix writer stages`);
	}
	if (final?.agent !== "pi-shipyard.shipwright" || final?.outputMode !== "inline") {
		fail(`chains/${name}: delivery must end with an inline shipwright validation`);
	}
}

const chainDir = path.join(root, "chains");
for (const name of readdirSync(chainDir).filter((entry) => entry.endsWith(".chain.json")).sort()) {
	const file = path.join(chainDir, name);
	const chain = readJson(file);
	if (!chain) continue;
	if (!chain.name || !chain.description || !Array.isArray(chain.chain)) fail(`chains/${name}: invalid saved-chain root`);
	if (chain.package !== "pi-shipyard") fail(`chains/${name}: package must be pi-shipyard`);
	const available = new Set();
	const outputPaths = new Set();
	for (let index = 0; index < (chain.chain ?? []).length; index++) {
		const step = chain.chain[index];
		const produced = new Set();
		const outputTasks = Array.isArray(step.parallel) ? step.parallel : [step];
		for (const task of outputTasks) {
			if (typeof task.output !== "string") continue;
			if (outputPaths.has(task.output)) fail(`chains/${name} step ${index + 1}: duplicate output path ${task.output}`);
			outputPaths.add(task.output);
		}
		if (Array.isArray(step.parallel)) {
			for (const key of Object.keys(step)) if (!allowedStepKeys.has(key)) fail(`chains/${name} step ${index + 1}: unsupported group key ${key}`);
			const writerCount = step.parallel.filter((task) => task.agent === "pi-shipyard.implementation-worker").length;
			if (writerCount > 0) fail(`chains/${name} step ${index + 1}: writer agents may not run in parallel`);
			for (const task of step.parallel) inspectTask(`chains/${name}`, index + 1, task, available, produced, true);
		} else {
			inspectTask(`chains/${name}`, index + 1, step, available, produced, false);
		}
		for (const output of produced) available.add(output);
	}
	if ((chain.name.startsWith("review-") || ["ship", "deliver", "deliver-compact"].includes(chain.name)) && !JSON.stringify(chain).includes("{{SHIPYARD_STORE}}")) {
		fail(`chains/${name}: review workflow must use the extension-created Shipyard store placeholder`);
	}
	if (["deliver", "deliver-compact"].includes(chain.name)) validateDeliveryTopology(chain, name);
	if (chain.name === "deliver") {
		const childExecutions = chain.chain.reduce((total, step) => total + (Array.isArray(step.parallel) ? step.parallel.length : 1), 0);
		if (childExecutions > 8) fail(`chains/${name}: focused delivery may use at most 8 child executions, found ${childExecutions}`);
	}
	if (JSON.stringify(chain).includes("{chain_dir}")) fail(`chains/${name}: contains unsupported async {chain_dir} dependency`);
	const final = chain.chain.at(-1);
	if (final?.outputMode !== "inline") warnings.push(`chains/${name}: final step is not inline; completion notification may not contain the compact verdict`);
}

const promptDir = path.join(root, "prompts");
for (const name of readdirSync(promptDir).filter((entry) => entry.endsWith(".md"))) {
	const fm = parseFrontmatter(path.join(promptDir, name));
	if (!fm.description) fail(`prompts/${name}: missing description`);
}

if (errors.length > 0) {
	console.error("pi-shipyard validation failed:");
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}
console.log(`Validated ${agentFiles.length} agents, ${skillNames.size} skills, ${readdirSync(chainDir).filter((entry) => entry.endsWith('.chain.json')).length} chains, and ${readdirSync(promptDir).filter((entry) => entry.endsWith('.md')).length} prompts.`);
for (const warning of warnings) console.warn(`Warning: ${warning}`);
