export function parseCli(argv, definitions) {
  const values = { _: [], specified: new Set() };
  const byName = new Map();
  for (const definition of definitions) {
    for (const name of [definition.name, ...(definition.aliases ?? [])]) {
      byName.set(name.toLowerCase(), definition);
    }
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("-")) {
      values._.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    const rawName = equal >= 0 ? token.slice(0, equal) : token;
    const normalized = rawName.replace(/^--?/, "").toLowerCase();
    const definition = byName.get(normalized);
    if (!definition) throw new Error(`Unknown option: ${rawName}`);
    values.specified.add(definition.name);
    if (definition.type === "boolean") {
      if (equal >= 0) {
        const value = token.slice(equal + 1).toLowerCase();
        if (!["true", "false", "1", "0"].includes(value)) {
          throw new Error(`Option ${rawName} expects a boolean value.`);
        }
        values[definition.name] = ["true", "1"].includes(value);
      } else {
        values[definition.name] = true;
      }
      continue;
    }
    const value = equal >= 0 ? token.slice(equal + 1) : argv[++index];
    if (value === undefined || value.startsWith("-")) {
      throw new Error(`Option ${rawName} requires a value.`);
    }
    values[definition.name] = value;
  }
  return values;
}

export const gateDefinitions = [
  { name: "Path", aliases: ["path"] },
  { name: "ReportDirectory", aliases: ["report-directory"] },
  { name: "TimeoutSeconds", aliases: ["timeout"] },
  { name: "Profiler", aliases: ["profile"], type: "boolean" },
  { name: "Dictionary", aliases: ["dictionary"] },
  { name: "Help", aliases: ["h", "help"], type: "boolean" },
];
