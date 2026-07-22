import path from "node:path";

export type RepoInspectionAction = "status" | "diff" | "diff-staged" | "show" | "log";

export interface RepoInspectionInput {
	action: RepoInspectionAction;
	ref?: string;
	paths?: string[];
	limit?: number;
}

export function normalizeGitPaths(cwd: string, paths: string[] | undefined): string[] {
	const root = path.resolve(cwd);
	return (paths ?? []).map((entry) => {
		const raw = entry.startsWith("@") ? entry.slice(1) : entry;
		if (raw.startsWith("-")) throw new Error(`Git inspection path may not start with '-': ${entry}`);
		const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
		const relative = path.relative(root, absolute);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`Git inspection path must be below the current repository: ${entry}`);
		}
		return relative.split(path.sep).join("/");
	});
}

export function normalizeGitRef(ref: string | undefined): string {
	const value = ref?.trim() || "HEAD";
	if (value.startsWith("-") || !/^[A-Za-z0-9_./~^{}:+-]+$/.test(value)) throw new Error(`Invalid git revision: ${value}`);
	return value;
}

export function buildReadOnlyGitArgs(cwd: string, input: RepoInspectionInput): string[] {
	const paths = normalizeGitPaths(cwd, input.paths);
	const scopedPaths = paths.length ? ["--", ...paths] : [];
	const prefix = ["--no-optional-locks"];
	switch (input.action) {
		case "status":
			return [...prefix, "status", "--short", "--branch", ...scopedPaths];
		case "diff":
			return [...prefix, "diff", "--no-ext-diff", "--unified=80", ...scopedPaths];
		case "diff-staged":
			return [...prefix, "diff", "--cached", "--no-ext-diff", "--unified=80", ...scopedPaths];
		case "show":
			return [...prefix, "show", "--no-ext-diff", "--stat", "--oneline", normalizeGitRef(input.ref), ...scopedPaths];
		case "log":
			return [...prefix, "log", "--oneline", `-${input.limit ?? 20}`, ...scopedPaths];
	}
}
