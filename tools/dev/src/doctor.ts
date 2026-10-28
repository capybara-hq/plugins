import { findUpstream, parseRemoteConfig, REMOTE_URL_CONFIG_ARGS } from "./remotes.ts";
import type { Check } from "./report.ts";

export type DoctorEnv = {
  root: string;
  exec(cmd: string, args: string[]): { status: number; stdout: string };
  fileExists(p: string): boolean;
  readFile(p: string): string | null;
  isSymlinkTo(p: string, target: string): boolean;
  home: string;
  nodeVersion: string;
};

function major(version: string): number {
  return Number.parseInt(version.trim().replace(/^v/, ""), 10);
}

export async function runDoctor(env: DoctorEnv): Promise<Check[]> {
  const checks: Check[] = [];
  const at = (p: string) => `${env.root}/${p}`;

  const nodeMajor = major(env.nodeVersion);
  checks.push({
    id: "node",
    title: "Node.js 24",
    status: nodeMajor === 24 ? "pass" : "fail",
    detail: `found ${env.nodeVersion}`,
    ...(nodeMajor === 24 ? {} : { fix: "Install Node.js 24 (for example with nvm, fnm or mise)." }),
  });

  const pnpm = env.exec("pnpm", ["--version"]);
  const pnpmOk = pnpm.status === 0 && major(pnpm.stdout) === 10;
  checks.push({
    id: "pnpm",
    title: "pnpm 10",
    status: pnpmOk ? "pass" : "fail",
    detail: pnpm.status === 0 ? `found ${pnpm.stdout.trim()}` : "pnpm not found",
    ...(pnpmOk
      ? {}
      : { fix: "Install pnpm 10: corepack enable && corepack prepare pnpm@10 --activate" }),
  });

  const installed = env.readFile(at("node_modules/.pnpm/lock.yaml"));
  const lock = env.readFile(at("pnpm-lock.yaml"));
  const depsOk = installed !== null && lock !== null && installed === lock;
  checks.push({
    id: "deps",
    title: "Dependencies match the lockfile",
    status: depsOk ? "pass" : "fail",
    detail: depsOk
      ? "node_modules matches pnpm-lock.yaml"
      : installed === null
        ? "dependencies are not installed"
        : "node_modules differs from pnpm-lock.yaml",
    ...(depsOk ? {} : { fix: "pnpm install" }),
  });

  const docker = env.exec("docker", ["info"]);
  checks.push({
    id: "docker",
    title: "Docker daemon reachable",
    status: docker.status === 0 ? "pass" : "fail",
    detail: docker.status === 0 ? "docker info succeeded" : "docker daemon not reachable",
    ...(docker.status === 0
      ? {}
      : { fix: "Install and start Docker; tests start their own Postgres and Valkey containers." }),
  });

  const linkOk = env.isSymlinkTo(at(".claude/skills"), "../.agents/skills");
  checks.push({
    id: "skills-link",
    title: ".claude/skills symlink",
    status: linkOk ? "pass" : "fail",
    detail: linkOk
      ? ".claude/skills -> ../.agents/skills"
      : ".claude/skills is not a symlink to ../.agents/skills",
    ...(linkOk
      ? {}
      : {
          fix: "Run `git config core.symlinks true` and re-checkout the file: rm -rf .claude/skills && git checkout -- .claude/skills",
        }),
  });

  const remotes = parseRemoteConfig(env.exec("git", REMOTE_URL_CONFIG_ARGS).stdout);
  const upstream = findUpstream(remotes, "plugins");
  checks.push({
    id: "remotes",
    title: "Upstream remote",
    status: upstream !== null ? "pass" : "fail",
    detail:
      upstream === null
        ? "no remote points to github.com/capybara-hq/plugins (accepted URL forms: https://github.com/capybara-hq/plugins, git@github.com:capybara-hq/plugins, ssh://git@github.com/capybara-hq/plugins)"
        : upstream.fork
          ? `fork clone; upstream is "${upstream.remote}"`
          : 'main repository; upstream is "origin"',
    ...(upstream === null
      ? { fix: "git remote add upstream https://github.com/capybara-hq/plugins.git" }
      : {}),
  });

  const name = env.exec("git", ["config", "user.name"]);
  const email = env.exec("git", ["config", "user.email"]);
  const identityOk =
    name.status === 0 &&
    name.stdout.trim() !== "" &&
    email.status === 0 &&
    email.stdout.trim() !== "";
  checks.push({
    id: "git-identity",
    title: "Git identity",
    status: identityOk ? "pass" : "fail",
    detail: identityOk
      ? `${name.stdout.trim()} <${email.stdout.trim()}>`
      : "git user.name or user.email is not set",
    ...(identityOk
      ? {}
      : {
          fix: 'git config --global user.name "Your Name" && git config --global user.email "you@example.com"',
        }),
  });

  const ghVersion = env.exec("gh", ["--version"]);
  const ghAuth = ghVersion.status === 0 ? env.exec("gh", ["auth", "status"]) : null;
  const ghOk = ghAuth !== null && ghAuth.status === 0;
  checks.push({
    id: "gh",
    title: "GitHub CLI logged in",
    status: ghOk ? "pass" : "warn",
    detail:
      ghAuth === null ? "gh not installed" : ghOk ? "gh is authenticated" : "gh is not logged in",
    ...(ghOk
      ? {}
      : {
          fix:
            ghAuth === null
              ? "Install the GitHub CLI (https://cli.github.com), then run `gh auth login`."
              : "gh auth login",
        }),
  });

  const hasEnv = env.fileExists(`${env.home}/.capybara-test.env`);
  checks.push({
    id: "live-api-env",
    title: "Live API test env file",
    status: hasEnv ? "pass" : "skip",
    detail: hasEnv
      ? "~/.capybara-test.env present"
      : "~/.capybara-test.env not found (optional, live API tests only)",
  });

  return checks;
}
