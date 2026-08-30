import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const VERSION_PATTERN = /^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function run(command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? result.stderr.trim() : "";
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }

  return capture ? result.stdout.trim() : "";
}

function currentVersion(): string {
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  return config.version;
}

function setJsonVersion(path: string, version: string): void {
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.version = version;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function setCargoVersion(path: string, version: string): void {
  const source = readFileSync(path, "utf8");
  const next = source.replace(
    /(\[package\][\s\S]*?\nversion = ")[^"]+("\n)/,
    `$1${version}$2`,
  );
  if (next === source) throw new Error(`Could not update ${path}`);
  writeFileSync(path, next);
}

function validateVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(
      `Invalid version "${version}". Convert It uses ZeroVer: expected 0.MINOR.PATCH, optionally with a prerelease suffix. See https://0ver.org/.`,
    );
  }
}

function ensureCleanWorktree(): void {
  if (run("git", ["status", "--porcelain"], true)) {
    throw new Error("Working tree is not clean. Commit or stash changes first.");
  }
}

function ensureRemote(): void {
  if (!run("git", ["remote", "get-url", "origin"], true)) {
    throw new Error("Git remote 'origin' is not configured.");
  }
}

function ensureTagIsAvailable(tag: string): void {
  if (run("git", ["tag", "--list", tag], true)) {
    throw new Error(`Tag ${tag} already exists locally.`);
  }
  if (run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], true)) {
    throw new Error(`Tag ${tag} already exists on origin.`);
  }
}

function syncVersions(version: string): void {
  setJsonVersion("package.json", version);
  setJsonVersion("src-tauri/tauri.conf.json", version);
  setCargoVersion("src-tauri/Cargo.toml", version);
}

function validateBuild(updateLockfile = false): void {
  run("bun", ["install", "--frozen-lockfile"]);
  const cargoArgs = ["check", "--manifest-path", "src-tauri/Cargo.toml"];
  if (!updateLockfile) cargoArgs.push("--locked");
  run("cargo", cargoArgs);
}

function publish(version: string): void {
  ensureCleanWorktree();
  ensureRemote();

  const tag = `v${version}`;
  ensureTagIsAvailable(tag);
  syncVersions(version);
  validateBuild(true);
  run("bun", ["test"]);
  run("bun", ["run", "build"]);

  run("git", [
    "add",
    "package.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
  ]);
  const hasVersionChanges = run("git", ["diff", "--cached", "--name-only"], true) !== "";
  if (hasVersionChanges) {
    run("git", ["commit", "-m", `chore(release): ${tag}`]);
  }
  run("git", ["tag", "-a", tag, "-m", `Convert It ${tag}`]);
  run("git", ["push", "origin", "HEAD"]);
  run("git", ["push", "origin", tag]);

  console.log(`Release ${tag} pushed. GitHub Actions will publish the installers.`);
}

function verify(): void {
  const version = currentVersion();
  validateVersion(version);

  const packageVersion = JSON.parse(
    readFileSync("package.json", "utf8"),
  ).version;
  const cargoVersion = readFileSync("src-tauri/Cargo.toml", "utf8").match(
    /\[package\][\s\S]*?\nversion = "([^"]+)"/,
  )?.[1];

  if (packageVersion !== version || cargoVersion !== version) {
    throw new Error(
      `Version mismatch: package.json=${packageVersion}, Cargo.toml=${cargoVersion}, tauri.conf.json=${version}`,
    );
  }
  if (!existsSync(".github/workflows/release.yml")) {
    throw new Error("Missing .github/workflows/release.yml");
  }

  validateBuild();
  run("bun", ["test"]);
  run("bun", ["run", "build"]);
  console.log(`Release configuration is valid for v${version}.`);
}

function dryRun(version: string): void {
  ensureRemote();
  const tag = `v${version}`;
  ensureTagIsAvailable(tag);
  console.log(
    `Dry run valid for ${tag}. A real release requires a clean working tree and will update versions, test, commit, tag, and push.`,
  );
}

function usage(): never {
  console.error("Usage: bun scripts/release.ts <version>|--verify|--dry-run <version>");
  process.exit(2);
}

try {
  const argument = process.argv[2];
  if (argument === "--verify") {
    verify();
  } else if (argument === "--dry-run") {
    const version = process.argv[3];
    if (!version) usage();
    validateVersion(version);
    dryRun(version);
  } else if (argument) {
    validateVersion(argument);
    publish(argument);
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
