import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildReadOnlyGitArgs } from "../extensions/repo-inspection.ts";

const cwd = "/tmp/shipyard-repo";

for (const action of ["status", "diff", "diff-staged", "show", "log"] as const) {
	test(`builds ${action} with Git optional locks disabled`, () => {
		const args = buildReadOnlyGitArgs(cwd, { action, ref: "HEAD^", paths: ["src/file.ts"], limit: 7 });
		assert.equal(args[0], "--no-optional-locks");
		assert.equal(args.includes("--"), true);
		assert.equal(args.at(-1), "src/file.ts");
	});
}

test("rejects option-like, absolute-outside, and traversal paths", () => {
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "diff", paths: ["--output=x"] }), /may not start/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "diff", paths: ["../outside"] }), /must be below/);
	assert.throws(() => buildReadOnlyGitArgs(cwd, { action: "show", ref: "--help" }), /Invalid git revision/);
});

test("status inspection does not refresh or rewrite the Git index", async () => {
	const repo = await mkdtemp(path.join(os.tmpdir(), "shipyard-git-readonly-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Shipyard Test"], { cwd: repo });
		await writeFile(path.join(repo, "file.txt"), "content\n");
		execFileSync("git", ["add", "file.txt"], { cwd: repo });
		execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
		const indexPath = path.join(repo, ".git", "index");
		const beforeBytes = await readFile(indexPath);
		const future = new Date(Date.now() + 5_000);
		await utimes(path.join(repo, "file.txt"), future, future);
		execFileSync("git", buildReadOnlyGitArgs(repo, { action: "status" }), { cwd: repo });
		assert.deepEqual(await readFile(indexPath), beforeBytes);
		assert.equal((await stat(indexPath)).size, beforeBytes.length);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});
