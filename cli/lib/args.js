// pm's argument parser, unchanged from 0.x (DD-023 keeps it: no library keeps its rules).
// - A flag with no value, or before another flag, is the string "true".
// - all, help, json and all-claims never take a value.
// - --server takes a value only when it looks like a URL or a host, so `--server SB-2` keeps SB-2.
// - Every value is a string; `--blockedBy ''` is the empty string, which clears the list.

const BOOLEAN_FLAGS = new Set(['all', 'help', 'json', 'all-claims']);

export function parseArgs(argv) {
  const subcmd = argv[0] || '';
  const positional = [];
  const flags = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = 'true';
      } else if (key === 'server') {
        const next = argv[i + 1];
        if (next && !next.startsWith('--') && /^https?:\/\//.test(next)) {
          flags[key] = argv[++i];
        } else if (next && !next.startsWith('--') && /^([\w-]+(\.[\w-]+)+|[\w.-]+:\d+)$/.test(next)) {
          flags[key] = `http://${argv[++i]}`;
        } else {
          flags[key] = 'true';
        }
      } else {
        const val = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
        flags[key] = val;
      }
    } else {
      positional.push(argv[i]);
    }
  }
  return { subcmd, positional, flags };
}
