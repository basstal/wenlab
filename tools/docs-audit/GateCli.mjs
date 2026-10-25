import path from "node:path";
import { invokeDocsAudit } from "./DocsAudit.mjs";
import { gateDefinitions, parseCli } from "./Cli.mjs";

const usage = (gate) =>
  `Usage: node ${gate}.mjs [-Path <file-or-directory>] [-ReportDirectory <directory>] [-TimeoutSeconds <1-3600>] [-Profiler] [-Dictionary <file>]`;

export async function runGateCli(gate, argv = process.argv.slice(2)) {
  try {
    const options = parseCli(argv, gateDefinitions);
    if (options.Help) {
      console.log(usage(gate));
      return 0;
    }
    if (options._.length) {
      throw new Error(`Unexpected argument: ${options._[0]}`);
    }
    const timeoutSeconds = options.TimeoutSeconds === undefined ? 180 : Number(options.TimeoutSeconds);
    return await invokeDocsAudit({
      gate,
      path:
        options.specified.has("Path") && !path.isAbsolute(options.Path)
          ? path.resolve(process.cwd(), options.Path)
          : options.Path ?? "docs",
      reportDirectory: options.ReportDirectory ?? ".tmp/docs-audit",
      timeoutSeconds,
      profiler: Boolean(options.Profiler),
      dictionary: options.Dictionary,
    });
  } catch (failure) {
    console.error(`[ERROR] ${failure instanceof Error ? failure.message : String(failure)}`);
    console.error(usage(gate));
    return 2;
  }
}
