import type { Command } from "commander";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import { ControlPlaneClient } from "../../src/agent/client.js";
import { buildAttestBody } from "../../src/agent/narinfo.js";
import { partitionByUpstream } from "../../src/agent/upstream.js";
import { mapConcurrent } from "../../src/agent/concurrency.js";
import { nixBuild, pathInfoClosure, makeNar } from "../../agent/nix.js";
import { requireCredential } from "../context.js";
import { star, success, info, fail, isTTY } from "../ui.js";

function fmtSize(bytes: number): string {
  const u = ["B", "KiB", "MiB", "GiB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function registerPush(program: Command): void {
  program
    .command("push [installable...]")
    .description("Build locally and upload novel store paths to your namespace")
    .option("--no-skip-upstream", "Upload the whole closure, not just paths missing from the upstream cache")
    .option("--upstream <url>", "Upstream cache to diff against", "https://cache.nixos.org")
    .option("-j, --jobs <n>", "Upload concurrency", (v) => parseInt(v, 10), 4)
    .option("--json", "emit NDJSON progress events")
    .action(
      async (
        installables: string[],
        opts: { skipUpstream: boolean; upstream: string; jobs: number; json?: boolean },
      ) => {
        const targets = installables.length > 0 ? installables : ["."];
        for (const t of targets) {
          if (t.startsWith("-")) fail(`refusing an installable that looks like a flag: ${t}`);
        }
        const cred = await requireCredential();
        const client = new ControlPlaneClient(cred.url, cred.credential);
        const work = await mkdtemp(join(tmpdir(), "vega-push-"));
        const ns = `owner:${cred.userId ?? "?"}`;
        let pushed = 0;

        try {
          for (const installable of targets) {
            if (!opts.json) info(star(`Building ${pc.bold(installable)}`));
            await nixBuild(installable); // streams nix's own logs to stderr

            const closure = await pathInfoClosure(installable);
            let paths = closure;
            if (opts.skipUpstream) {
              const { novel, upstream } = await partitionByUpstream(
                closure.map((p) => p.path),
                opts.upstream,
              );
              const novelSet = new Set(novel);
              paths = closure.filter((p) => novelSet.has(p.path));
              if (!opts.json) {
                info(
                  `  Closure ${closure.length} paths: ${pc.yellow(`${paths.length} novel`)}, ` +
                    `${upstream.length} already upstream`,
                );
              }
            }
            if (opts.json) info(JSON.stringify({ event: "plan", installable, novel: paths.length }));

            let done = 0;
            let bytes = 0;
            const tick = (size: number, path: string): void => {
              done++;
              bytes += size;
              if (opts.json) {
                info(JSON.stringify({ event: "pushed", path, size, done, total: paths.length }));
              } else if (isTTY) {
                process.stdout.write(
                  `\r  Uploading ${done}/${paths.length}  (${fmtSize(bytes)})        `,
                );
              } else if (done % 10 === 0 || done === paths.length) {
                info(`  uploaded ${done}/${paths.length}`);
              }
            };

            await mapConcurrent(paths, opts.jobs, async (p) => {
              const nar = await makeNar(p.path, work);
              const url = await client.uploadUrl(nar.url);
              await client.putNar(url, await readFile(nar.file));
              await client.push(buildAttestBody(p, nar));
              tick(nar.fileSize, p.path);
            });
            if (isTTY && !opts.json && paths.length > 0) process.stdout.write("\n");
            pushed += paths.length;
          }
        } finally {
          await rm(work, { recursive: true, force: true });
        }

        if (!opts.json) {
          success(`Pushed ${pushed} path(s) to ${pc.bold(ns)}.`);
          info(pc.gray(`Consumers who trust you (vega trust add ${cred.login}) get them via their view.`));
        }
      },
    );
}
