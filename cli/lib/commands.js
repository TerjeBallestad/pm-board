// Every pm command, once: its names, usage, help, flags and handler (DD-023, DD-025). The help
// text, `pm <command> --help`, the flag check, "did you mean" and dispatch all read this table.
//
// A handler keeps the 0.x code it replaced (pm-board-cli bin/pm), so the output stays the same.
// `flags` lists the flags a command reads. `fields(positional)` is true where a command sends any
// --key value to the server as a field (patch and its kin): there the server checks the names
// (DD-016), not this table.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import { appendPromptKnowledge } from './knowledge-base.js';
import {
  api, httpJson, flags, positional, state, usageError, hasRequestFlags, isRequestFlag, loadConfig,
  runKnowledgeQuery, aliasHint, BASE_URL, BOARD, BOARD_FILENAME, USER_CONFIG_PATH, PACKAGE_DIR, VERSION
} from './runtime.js';
import {
  printList, fetchTerms, printGlossary, printTerm, printGlossaryFooter, printSprintOverview, printPlanOverview, nextTaskSummary,
  printWrite, changes, claimEnd, archived, truncate
} from './output.js';
import {
  fetchListByType, routeById, commentRoute, expandFileArg, resolveBody, buildItemBody,
  buildPatchBody, rejectCommandWordTitle, bodyField, bodyHash, withBodyHash
} from './records.js';

export const GROUPS = ['Read', 'Write', 'Plans and tasks', 'Projects', 'More', 'Setup'];

const LIST_FLAGS = ['type', 'stage', 'priority', 'sprint', 'frontier', 'all-claims', 'limit', 'all', 'json'];
const LIST_FLAG_HELP = [
  ['--stage S', 'Only records in stage S'],
  ['--priority P', 'Only records with priority P'],
  ['--sprint SPRINT-NNN', 'Only records in that project'],
  ['--frontier', 'Not done, not blocked, not claimed (pm ready)'],
  ['--all-claims', 'With --frontier: claimed records too'],
  ['--limit N', 'Show the newest N (default 20)'],
  ['--all', 'Show every record'],
  ['--json', 'The records as JSON, unsorted and uncut'],
];
const isId = (s, prefix) => new RegExp(`^${prefix}-\\d+$`, 'i').test(s || '');

async function listCommand() {
  // Canonical: pm list [<type>] [filters]. Type comes from positional[0] or --type (back-compat).
  const typeArg = positional[0] || flags.type;
  printList(await fetchListByType(typeArg));
}

// --- items ---

const get = {
  name: 'get', aliases: ['show'], group: 'Read',
  synopsis: 'get <id> [--brief]', usage: 'get <id> [--brief]',
  summary: 'One record as JSON; the terms it mentions follow',
  help: 'Shows an item, design, plan, project or task by its id. A task comes with its planId. The\nglossary terms that its title, body and comments mention are listed after it, on stderr, so\nstdout stays pure JSON. A record with a body has bodyHash, for pm patch --base (DD-030).',
  flags: ['brief'],
  flagHelp: [['--brief', 'Leave out the body and comments; show their sizes and bodyHash instead']],
  examples: ['pm get SB-042', 'pm get TASK-021', 'pm get PLAN-003 --brief'],
  async run() {
    const id = positional[0];
    if (!id) usageError('Usage: pm get <id>');
    // A task by its key (DD-026). 0.x refused: tasks were read through their plan.
    const path = /^TASK-\d+$/i.test(id) ? `/api/tasks/${id}` : routeById(id);
    if (flags.brief === 'true') {
      // Metadata-only view: everything except the large free-text fields,
      // with size hints so agents know when a full `pm get` is worth it.
      const entity = await api('GET', path, undefined, { silent: true });
      const { body, comments, ...rest } = entity;
      if (body) rest.bodyChars = body.length;
      if (typeof body === 'string' && body) rest.bodyHash = bodyHash(body);
      if (comments?.length) rest.commentCount = comments.length;
      process.stdout.write(JSON.stringify(rest, null, 2) + '\n');
    } else {
      const entity = await api('GET', path, undefined, { silent: true });
      process.stdout.write(JSON.stringify(withBodyHash(entity), null, 2) + '\n');
      await printGlossaryFooter(entity);
    }
  },
};

const list = {
  name: 'list', group: 'Read',
  synopsis: 'list [<type>] [filters]',
  usage: 'list [<type>] [--stage S] [--priority P] [--sprint ID] [--frontier] [--limit N] [--all] [--json]',
  summary: 'Records as "ID  title", oldest first, the newest 20',
  help: () => `Lists records as one line each, sorted oldest to newest, so the newest are closest to the\nprompt. <type> is sdd, plan, sprint or an item type (${itemTypeWords()}); it also\ntakes a prefix (SB), a plural or a label. With no type, every item.`,
  flags: LIST_FLAGS, flagHelp: LIST_FLAG_HELP,
  examples: ['pm list', 'pm list decision --sprint SPRINT-003', 'pm list --frontier', 'pm list plan'],
  run: listCommand,
};

const ready = {
  name: 'ready', group: 'Read',
  synopsis: 'ready [<type>] [--sprint ID]', usage: 'ready [<type>] [--sprint ID] [--all-claims] [--limit N] [--all] [--json]',
  summary: 'Work that can start now: not done, not blocked, not claimed',
  help: 'The frontier: records that are not done, whose blockers are all done, and that no live\nclaim holds. The same as pm list --frontier.',
  flags: LIST_FLAGS.filter(f => f !== 'frontier'), flagHelp: LIST_FLAG_HELP.filter(([f]) => f !== '--frontier'),
  examples: ['pm ready', 'pm ready issue --sprint SPRINT-003'],
  async run() {
    flags.frontier = 'true';
    await listCommand();
  },
};

const glossary = {
  name: 'glossary', group: 'Read',
  synopsis: 'glossary [<word>] [--json]', usage: 'glossary [<word>] [--json]',
  summary: 'Every term on the board: one word, one meaning',
  help: 'Prints every term. Read it once and hold it. A word with no definition is a signpost: it\nlists the unambiguous words to use instead. pm get footnotes the terms it printed.\nWith a <word>: that term, its aliases and its definition, or what to use instead.\n\nTo add a term:      pm create term "the-word" --body "One sentence."\nTo add inflections: pm patch TERM-001 --aliases the-words,the-wording\n                    (explicit forms only, never stemming; an alias is never an ambiguous word)',
  flags: ['json'],
  flagHelp: [['--json', 'The terms as JSON, or the one term']],
  examples: ['pm glossary', 'pm glossary board'],
  async run() {
    if (positional.length) return printTerm(await fetchTerms(), positional.join(' '));
    // Deliberately NOT a get-or-create shorthand like `pm issue`/`pm decision`:
    // for a curated glossary, `pm term merje` silently minting junk is a bad
    // trade. Lookup is `pm get TERM-001`; creation is `pm create term "word"`.
    printGlossary(await fetchTerms());
  },
};

const create = {
  name: 'create', write: true, group: 'Write',
  synopsis: 'create <type> "title" [...]',
  usage: 'create <type> "title" [--priority P] [--body B] [--pillar P] [--sprint ID] [--files f1,f2] [--blockedBy IDs]',
  summary: 'A new item (issue, decision, concern, gap, term, ...)',
  help: () => `Creates an item and prints one line with its new key. <type> is an item type\n(${itemTypeWords()}). Projects, designs and plans have their own commands:\npm project create, pm sdd create, pm plan create.`,
  flags: ['priority', 'body', 'pillar', 'sprint', 'files', 'blockedBy'],
  flagHelp: [
    ['--priority P', 'low, medium, high or critical'],
    ['--body B', 'Markdown; --body @file.md reads a file, --body - reads stdin'],
    ['--sprint SPRINT-NNN', 'Put it in that project'],
    ['--pillar P', 'A design pillar'],
    ['--files f1,f2', 'Affected files'],
    ['--blockedBy IDs', 'Records that must be done first'],
  ],
  examples: ['pm create issue "Login fails after timeout" --priority high', 'pm create decision "Use cookies" --sprint SPRINT-003 --body @dd.md'],
  async run() {
    const type = positional[0];
    const title = positional[1];
    if (!type || !title) usageError('Usage: pm create <type> "title"');
    // Reserved entity types have dedicated creation commands — rejecting these
    // prevents creating orphaned items with reserved prefixes (e.g. SPRINT-N
    // items that aren't real sprints).
    const RESERVED = { sprint: 'pm project create "name"', sdd: 'pm sdd create "title"', design: 'pm sdd create "title"', plan: 'pm plan create < plan.json', task: 'pm task-update <plan-id> <task-id>', milestone: 'milestones have no CLI creation yet' };
    const reservedHint = RESERVED[type.toLowerCase()];
    if (reservedHint) usageError(`"${type}" is not a generic item type. Use: ${reservedHint}`);
    await resolveBody();
    await createItem(buildItemBody(type, title));
  },
};

/** One record as JSON, with bodyHash when it has a body, as pm get prints it (DD-030). */
async function printRecord(path) {
  const record = await api('GET', path, undefined, { silent: true });
  process.stdout.write(JSON.stringify(withBodyHash(record), null, 2) + '\n');
}

/** Create an item and print its receipt (DD-027). */
async function createItem(body) {
  const item = await api('POST', '/api/items', body, { silent: true });
  printWrite(item, `created ${item.id} (${item.type}${item.sprintId ? `, ${item.sprintId}` : ''}): ${truncate(item.title, 100)}`);
}

/** Change a record and print what changed (DD-027). */
async function patchRecord(path, id, body) {
  const record = await api('PATCH', path, body, { silent: true });
  printWrite(record, `updated ${record?.id || id}: ${changes(body, record) || 'nothing sent'}`);
}

const patchHelp = () => `Update any field on an item, design, or plan. The server refuses a field it does not know.

A body write never loses text (DD-030). Items, designs and projects:
  --prepend-body TEXT   Add a block at the top of the body (@file.md, or - for stdin)
  --append-body TEXT    Add a block at the end of the body (@file.md, or -)
  --body TEXT           Replace the whole body (@file.md, or -). A body with text needs
                        --base or --force; an empty one needs neither
  --base HASH           The bodyHash from pm get: the body you replace. If the body
                        changed since, nothing is written and pm exits 3
  --force               Replace the body with no check
  A value that starts with -- is read as a flag: put such a block in a file (@block.md).

Items (SB, DD, DC, GAP, ...):
  --title T            Rename
  --stage S             Move to stage (${state.config?.stages?.join(', ') || 'inbox, exploring, sdd, planned, done'})
  --priority P          Set priority (low, medium, high, critical)
  --pillar P            Set design pillar
  --sprint SPRINT-NNN   Assign to sprint
  --files f1,f2         Set affected files (comma-separated)
  --related IDs         Set related IDs (comma-separated, e.g. SDD-060,DD-042)
  --blockedBy IDs       Set blocking edges (comma-separated; '' clears). Items whose
                        blockers are all done/archived show in "pm ready"
  --assignee LABEL      Force-set/override a claim ('' clears). Normal claiming
                        goes through "pm claim <id> --as LABEL" (conflict-checked)
  --aliases a,b         A term's inflections

Designs (SDD):
  --title T             Rename
  --stage S             Move to stage
  --items IDs           Set linked item IDs (comma-separated)
  --sprint SPRINT-NNN   Assign to sprint

Plans (PLAN):
  --title T             Rename
  --stage S             Move to stage
  --context TEXT        Set plan context
  --sprint SPRINT-NNN   Assign to sprint
  --tasks @file.json    Replace all tasks from JSON file

Projects (SPRINT):
  --name N              Rename
  --status S            Set status (active, completed)

Exit codes: 0 done, 1 error, 2 usage, 3 a body write refused (read it again).`;

const patch = {
  name: 'patch', write: true, group: 'Write',
  synopsis: 'patch <id> --field value ...', usage: 'patch <id> [--field value ...]',
  summary: 'Change fields of an item, design, plan or project',
  help: patchHelp,
  fields: () => true,
  examples: ['pm patch SB-042 --stage done', 'pm patch SB-042 --prepend-body @block.md', 'pm patch SB-042 --body @new.md --base 3f2a9c1b04de', 'pm patch SB-042 --blockedBy SB-040,SB-041', "pm patch SB-042 --assignee ''"],
  async run() {
    const id = positional[0];
    if (!id) usageError('Usage: pm patch <id> [--key value ...]');
    await resolveBody();
    await patchRecord(routeById(id), id, buildPatchBody());
  },
};

const comment = {
  name: 'comment', write: true, group: 'Write',
  synopsis: 'comment <id> "text" [--author A]', usage: 'comment <id> "text" [--author A]',
  summary: 'Add a comment to an item, design, plan or project',
  help: 'Adds a comment. The author is "claude" unless --author names someone.',
  flags: ['author'],
  flagHelp: [['--author A', 'Who wrote it (default: claude)']],
  examples: ['pm comment SB-042 "Fixed in abc123; tests pass"'],
  async run() {
    const id = positional[0];
    const text = positional[1];
    if (!id || !text) usageError('Usage: pm comment <id> "text" [--author A]');
    const path = commentRoute(id);
    const c = await api('POST', path, { text, author: flags.author || 'claude' }, { silent: true });
    printWrite(c, `commented on ${id.toUpperCase()} as ${c?.author || flags.author || 'claude'}`);
  },
};

const claim = {
  name: 'claim', write: true, group: 'Write',
  synopsis: 'claim <id> --as "label"', usage: 'claim <id> --as "label"',
  summary: 'Claim a ticket for this session; fails if another holds it',
  help: 'Claims a ticket for this session. It fails while another session holds a live claim.\nClaims expire after the board\'s claimTtlHours (default 4). Closing the ticket releases it.\nThe label comes from --as, else from CLAUDE_SESSION_ID.',
  flags: ['as'],
  flagHelp: [['--as LABEL', 'Who works on it (default: $CLAUDE_SESSION_ID)']],
  examples: ['pm claim SB-042 --as "session-a"'],
  async run() {
    const id = positional[0];
    if (!id) usageError('Usage: pm claim <id> --as "session label"');
    const assignee = flags.as || process.env.CLAUDE_SESSION_ID;
    if (!assignee) {
      usageError('Usage: pm claim <id> --as "session label"\n' +
        'A claim needs an assignee label (who is working this ticket).');
    }
    const item = await api('POST', `/api/items/${encodeURIComponent(id)}/claim`, { assignee }, { silent: true });
    printWrite(item, `claimed ${item.id} for ${item.assignee} ${claimEnd(item)}`);
  },
};

const release = {
  name: 'release', write: true, group: 'Write',
  synopsis: 'release <id>', usage: 'release <id>',
  summary: 'Release a claim without closing the ticket',
  async run() {
    const id = positional[0];
    if (!id) usageError('Usage: pm release <id>');
    const item = await api('POST', `/api/items/${encodeURIComponent(id)}/release`, {}, { silent: true });
    printWrite(item, `released ${item.id}`);
  },
};

const archive = {
  name: 'archive', write: true, group: 'Write',
  synopsis: 'archive <id> [<id> ...]', usage: 'archive <id> [<id> ...]',
  summary: 'Move items to the archive',
  examples: ['pm archive SB-040 SB-041'],
  async run() {
    if (positional.length === 0) usageError('Usage: pm archive <id> [<id2>...]');
    const answer = await api('POST', '/api/items/archive', { ids: positional }, { silent: true });
    printWrite(answer, archived(answer, 'archived nothing: no live item has those ids'));
  },
};

// --- plans and tasks ---

const plan = {
  name: 'plan', write: true, group: 'Plans and tasks',
  synopsis: 'plan <id> [--json]', usage: ['plan <PLAN-id> [--json]', 'plan create < plan.json', 'plan list [--sprint ID]'],
  summary: 'A plan\'s overview: one line per task, and the next task',
  help: 'Shows a plan: its project and notes in short, one line per task with its status and open\nblockers, and the next task. pm get TASK-NNN reads one task in full; --json gives the whole\nplan. pm patch PLAN-NNN changes its title, stage or tasks.\nWith create: a new plan from JSON on stdin:\n{"title": ..., "sprintId": ..., "context": {...}, "tasks": [{"title": ..., "blockedBy": ["Task 1"]}]}',
  flags: ['sprint', 'all', 'limit', 'json'],
  flagHelp: [['--json', 'The whole plan, every task in full']],
  examples: ['pm plan PLAN-003', 'pm get TASK-021', 'pm plan create < plan.json', 'pm patch PLAN-003 --stage done'],
  async run() {
    const action = positional[0];
    if (action === 'list') {
      printList(await fetchListByType('plan'));
      return;
    }
    if (action === 'create') {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const input = Buffer.concat(chunks).toString().trim();
      if (!input) usageError('Usage: pm plan create < plan.json');
      let planData;
      try { planData = JSON.parse(input); }
      catch (e) { usageError(`Invalid JSON: ${e.message}`); }
      const created = await api('POST', '/api/plans', planData, { silent: true });
      const ts = created.tasks || [];
      printWrite(created, `created ${created.id}: ${truncate(created.title, 80)}, ${ts.length} task${ts.length === 1 ? '' : 's'}` +
        `${ts.length ? ` (${ts[0].id}${ts.length > 1 ? `..${ts[ts.length - 1].id}` : ''})` : ''}. Next: pm plan ${created.id}`);
    } else if (action && isId(action, 'PLAN')) {
      if (flags.json === 'true') {
        await api('GET', `/api/plans/${action}`);
        return;
      }
      const planRecord = await api('GET', `/api/plans/${action}`, undefined, { silent: true });
      const next = await api('GET', `/api/plans/${action}/next-task`, undefined, { silent: true });
      printPlanOverview(planRecord, next);
    } else {
      usageError('Usage: pm plan <PLAN-id> | pm plan create < plan.json');
    }
  },
};

const nextTask = {
  name: 'next-task', group: 'Plans and tasks',
  synopsis: 'next-task <plan-id> [--json]', usage: 'next-task <plan-id> [--json]',
  summary: 'The next task in full, and every task in short',
  help: 'Prints JSON: the next task (the first that has not passed and whose blockers passed) in\nfull under "next", and every task in short under "tasks", with the last progress note of each\nfinished one. pm get TASK-NNN reads another task in full.',
  flags: ['json'],
  flagHelp: [['--json', 'Every task in full, each with "unblocked" (as before 1.1)']],
  examples: ['pm next-task PLAN-003'],
  async run() {
    const planId = positional[0];
    if (!planId) usageError('Usage: pm next-task <plan-id>');
    if (flags.json === 'true') {
      await api('GET', `/api/plans/${planId}/next-task`);
      return;
    }
    const answer = await api('GET', `/api/plans/${planId}/next-task`, undefined, { silent: true });
    process.stdout.write(JSON.stringify(nextTaskSummary(planId, answer), null, 2) + '\n');
  },
};

const taskUpdate = {
  name: 'task-update', write: true, group: 'Plans and tasks',
  synopsis: 'task-update <plan> <task> [...]',
  usage: 'task-update <plan-id> <task-id> [--status S] [--passes true|false] [--note N] [--description D] [--steps JSON] [--verification V]',
  summary: 'Change a task\'s status, or add a progress note',
  help: 'Changes a task. --note adds a progress note; it never replaces the earlier ones.',
  flags: ['status', 'passes', 'note', 'description', 'steps', 'verification'],
  flagHelp: [
    ['--status S', 'pending, in_progress or done'],
    ['--passes true|false', 'Whether its verification passed'],
    ['--note N', 'A progress note (@file.md, or - for stdin)'],
    ['--description D', 'New description (@file.md, or -)'],
    ['--steps JSON', 'New steps, a JSON array of strings'],
    ['--verification V', 'New verification text'],
  ],
  examples: ['pm task-update PLAN-003 TASK-020 --status in_progress --note "started"'],
  async run() {
    const planId = positional[0];
    const taskId = positional[1];
    if (!planId || !taskId) {
      usageError('Usage: pm task-update <plan-id> <task-id> [--status S] [--passes true|false] [--note N | @file.md | -]');
    }
    const body = {};
    if (flags.status) body.status = flags.status;
    if (flags.passes) body.passes = flags.passes === 'true';
    if (flags.note) body.progressNote = await expandFileArg(flags.note, 'note');
    if (flags.description) body.description = await expandFileArg(flags.description, 'description');
    if (flags.steps) {
      try { body.steps = JSON.parse(flags.steps); }
      catch (e) { usageError(`Invalid JSON for --steps: ${e.message}`); }
    }
    if (flags.verification) body.verification = flags.verification;
    const task = await api('PATCH', `/api/plans/${planId}/tasks/${taskId}`, body, { silent: true });
    const { progressNote, ...fields } = body;
    const parts = [changes(fields, task)];
    if (progressNote) {
      const n = (task.progressNotes || []).length;
      parts.push(`note added (${n} note${n === 1 ? '' : 's'})`);
    }
    printWrite(task, `updated ${task.id} in ${planId.toUpperCase()}: ${parts.filter(Boolean).join(', ') || 'nothing sent'}`);
  },
};

const taskDone = {
  name: 'task-done', write: true, group: 'Plans and tasks',
  synopsis: 'task-done <plan> <task> "note"', usage: 'task-done <plan-id> <task-id> "note" | @file.md | -',
  summary: 'Mark a task done and passing, with a progress note',
  examples: ['pm task-done PLAN-003 TASK-020 "abc123 on main; checks pass"', 'pm task-done PLAN-003 TASK-020 @note.md'],
  async run() {
    const planId = positional[0];
    const taskId = positional[1];
    let note = positional[2];
    if (!planId || !taskId || !note) {
      usageError('Usage: pm task-done <plan-id> <task-id> "progress note" | @file.md | -');
    }
    note = await expandFileArg(note, 'note');
    const task = await api('PATCH', `/api/plans/${planId}/tasks/${taskId}`, {
      passes: true, status: 'done', progressNote: note
    }, { silent: true });
    printWrite(task, `done ${task.id} in ${planId.toUpperCase()}, passes, note added. Next: pm next-task ${planId.toUpperCase()}`);
  },
};

// --- projects ---

const project = {
  // `pm sprint` still works (the daily-plan skill calls it), but the help names only project (DD-015, DD-028).
  name: 'project', write: true, hiddenAliases: ['sprint'], group: 'Projects',
  synopsis: 'project [<id>] [--json]',
  usage: ['project [<SPRINT-id>] [--json]', 'project create "name" [--destination D] [--body B]', 'project <SPRINT-id> [--name N] [--destination D] [--body B] [--status S]', 'project list'],
  summary: 'A project\'s overview (default: the active one), or create one',
  help: 'With an id or none: an overview of the project, one line per item with its stage and open\nblockers, then its designs and plan progress. --json gives the full record. Ids stay SPRINT-NNN.\nWith flags after the id: changes the project. --body is its markdown doc. To change a doc\nthat has text: --prepend-body or --append-body, or --body with --base (as pm patch, DD-030).',
  flags: ['json', 'destination', 'problem-statement', 'body', 'all', 'limit'],
  fields: (pos) => isId(pos[0], 'SPRINT'),
  flagHelp: [
    ['--json', 'The full project with its records'],
    ['--destination D', 'Where the project arrives (create or change)'],
    ['--body B', 'The project doc (@file.md, or -)'],
    ['--prepend-body B', 'Add a block at the top of the doc (with an id)'],
    ['--append-body B', 'Add a block at the end of the doc (with an id)'],
    ['--base HASH', 'With --body on a doc with text: its bodyHash (pm project <id> prints it)'],
    ['--force', 'With --body: replace the doc with no check'],
    ['--name N', 'Rename (with an id)'],
    ['--status S', 'active or completed (with an id)'],
  ],
  examples: ['pm project', 'pm project SPRINT-003', 'pm project create "pm 1.1" --destination "agents read less"', 'pm project SPRINT-003 --status completed'],
  async run() {
    const action = positional[0];
    if (action === 'list') {
      printList(await fetchListByType('sprint'));
      return;
    }
    // pm project create "name" [--destination "..."] [--body "markdown doc"]
    if (action === 'create') {
      const name = positional[1];
      if (!name) usageError('Usage: pm project create "name" [--destination "..."] [--body "markdown doc"]');
      await resolveBody();
      const body = { name };
      if (flags.destination) body.problemStatement = flags.destination;
      if (flags['problem-statement']) body.problemStatement = flags['problem-statement'];
      // --body is the project's markdown doc (decisions log, out-of-scope, …)
      if (flags.body) body.body = flags.body;
      const created = await api('POST', '/api/sprints', body, { silent: true });
      printWrite(created, `created ${created.id} (project): ${truncate(created.name, 100)}`);
      return;
    }
    // pm project SPRINT-NNN --name "..." (patch shorthand)
    if (action && isId(action, 'SPRINT') && hasRequestFlags()) {
      await resolveBody();
      const patchBody = {};
      for (const [key, val] of Object.entries(flags)) {
        if (!isRequestFlag(key)) continue;
        const mapped = bodyField(key, val);
        if (mapped) patchBody[mapped[0]] = mapped[1];
        else if (key === 'destination' || key === 'problem-statement') patchBody.problemStatement = val;
        else patchBody[key] = val;
      }
      await patchRecord(`/api/sprints/${action}`, action, patchBody);
      return;
    }
    // pm sprint [id] — get sprint detail (default: active sprint).
    // Compact overview by default; --json for the full dump.
    let sprintId = action;
    if (!sprintId) {
      const sprints = await api('GET', '/api/sprints', undefined, { silent: true });
      const active = sprints.findLast(s => s.status === 'active');
      if (!active) { process.stderr.write('No active sprint found\n'); process.exit(1); }
      sprintId = active.id;
    }
    const detail = await api('GET', `/api/sprints/${sprintId}`, undefined, { silent: true });
    if (flags.json === 'true') process.stdout.write(JSON.stringify(withBodyHash(detail), null, 2) + '\n');
    else printSprintOverview(detail);
  },
};

// --- more ---

const sdd = {
  // Out of the help (DD-028): pm get, pm patch and pm list sdd read and change designs. It stays
  // for create, and skills call it, as `pm design create` too.
  name: 'sdd', write: true, aliases: ['design'], group: 'More', hidden: true,
  synopsis: 'sdd <id> | sdd "title"',
  usage: ['sdd <SDD-id> [--field value ...]', 'sdd create "title" [--body B] [--items IDs] [--sprint ID]', 'sdd "title"', 'sdd list'],
  summary: 'A design doc: get, create, or change one',
  help: 'With an id: shows the design, or changes it when flags follow (as pm patch).\nWith create or a title: creates one.',
  flags: ['body', 'items', 'sprint', 'all', 'limit'],
  fields: (pos) => isId(pos[0], 'SDD'),
  flagHelp: [
    ['--body B', 'The design doc (@file.md, or -)'],
    ['--prepend-body B', 'Add a block at the top of the doc (with an id)'],
    ['--append-body B', 'Add a block at the end of the doc (with an id)'],
    ['--base HASH', 'With --body on a doc with text: its bodyHash (pm sdd <id> prints it)'],
    ['--force', 'With --body: replace the doc with no check'],
    ['--items IDs', 'Linked items'],
    ['--sprint SPRINT-NNN', 'Put it in that project'],
  ],
  async run() {
    const action = positional[0];
    if (action === 'list') {
      printList(await fetchListByType('sdd'));
      return;
    }
    if (action === 'create') {
      const title = positional[1];
      if (!title) usageError('Usage: pm sdd create "title" [--body B] [--items IDs] [--sprint ID]');
      await resolveBody();
      const body = { title };
      if (flags.body) body.body = flags.body;
      if (flags.items) body.itemIds = flags.items.split(',');
      if (flags.sprint) body.sprintId = flags.sprint;
      await createDesign(body);
    } else if (action && isId(action, 'SDD')) {
      if (hasRequestFlags()) {
        await resolveBody();
        await patchRecord(`/api/designs/${action}`, action, buildPatchBody());
      } else {
        await printRecord(`/api/designs/${action}`);
      }
    } else if (action) {
      rejectCommandWordTitle(action, 'sdd');
      await resolveBody();
      const body = { title: action };
      if (flags.body) body.body = flags.body;
      if (flags.items) body.itemIds = flags.items.split(',');
      if (flags.sprint) body.sprintId = flags.sprint;
      await createDesign(body);
    } else {
      usageError('Usage: pm sdd <SDD-id or "title"> | pm sdd create "title"');
    }
  },
};

async function createDesign(body) {
  const d = await api('POST', '/api/designs', body, { silent: true });
  printWrite(d, `created ${d.id} (design): ${truncate(d.title, 100)}`);
}

// pm issue|gap|decision|concern <id or "title">: get, change (with flags) or create.
const shorthand = (name) => ({
  name, write: true, group: 'More',
  synopsis: `${name} <id> | ${name} "title"`, usage: [`${name} <id> [--field value ...]`, `${name} "title" [--priority P] [--body B] [--sprint ID] ...`, `${name} list`],
  summary: `Get, change or create a ${name}`,
  help: `With an id: shows it, or changes it when flags follow (as pm patch). With a title: creates\na ${name} (as pm create ${name}). With list: as pm list ${name}.`,
  flags: [...new Set(['priority', 'body', 'pillar', 'sprint', 'files', 'blockedBy', ...LIST_FLAGS])],
  fields: (pos) => /^[A-Z]+-\d+$/i.test(pos[0] || ''),
  // Out of the help (DD-028): pm create, pm get and pm patch do the same. Skills still call them.
  hidden: true,
  async run() {
    const arg = positional[0];
    if (!arg) usageError(`Usage: pm ${name} <id or "title">`);
    if (arg === 'list') {
      printList(await fetchListByType(name));
      return;
    }
    if (/^[A-Z]+-\d+$/i.test(arg)) {
      if (hasRequestFlags()) {
        await resolveBody();
        await patchRecord(routeById(arg), arg, buildPatchBody());
      } else {
        await printRecord(routeById(arg));
      }
    } else {
      rejectCommandWordTitle(arg, name);
      await resolveBody();
      await createItem(buildItemBody(name, arg));
    }
  },
});
const issue = shorthand('issue');
issue.synopsis = 'issue <id> | issue "title"';
issue.summary = 'Get, change or create an issue (also: decision, concern, gap)';

// `pm prompt` stays, out of the help: a brainstorming skill calls `pm prompt sdd <id>` (DD-028).
const prompt = {
  name: 'prompt', group: 'More', hidden: true,
  synopsis: 'prompt <type> <id>', usage: 'prompt <type> <id>',
  summary: 'A prompt scoped to one record',
  help: 'A prompt scoped to one record. <type> is item, sdd or plan. The board\'s knowledge-base\nqueries run on this machine, and their results are added at the end.',
  async run() {
    const entityType = positional[0];
    const entityId = positional[1];
    if (!entityType || !entityId) usageError('Usage: pm prompt <type> <id>');
    const answer = await api('POST', '/api/context/prompt', { entityType, entityId }, { silent: true });
    process.stdout.write(JSON.stringify(appendPromptKnowledge(answer, runKnowledgeQuery), null, 2) + '\n');
  },
};

// 0.x's `pm plans` stays, out of the help: the fix and execute-plan commands of three repos call it.
const plans = {
  name: 'plans', group: 'More', hidden: true, synopsis: 'plans', usage: 'plans [--sprint ID] [--all] [--limit N] [--json]',
  summary: 'As pm list plan', flags: LIST_FLAGS,
  async run() { printList(await fetchListByType('plans')); },
};

// Commands that went in pm 1.1 (DD-028): nobody ran them in the usage study, and no skill or
// command doc calls them. Each answers with exit 2 and the command to use instead.
const removed = (name, use) => ({
  name, group: 'More', hidden: true, board: false, anyFlags: true, removed: use,
  synopsis: name, usage: name, summary: `Removed in pm 1.1. Use: ${use}`,
  run() { usageError(`pm ${name} was removed in pm 1.1 (DD-028).\nUse: ${use}`); },
});

// --- setup ---

const init = {
  name: 'init', group: 'Setup', board: false,
  synopsis: 'init <slug> [--name N]', usage: 'init <slug> [--name "Board name"]',
  summary: 'Create or link this repo\'s board, and write .pm.json',
  help: 'Creates the board <slug> on the server and writes .pm.json in this folder. If the board\nexists, it links to it. Commit .pm.json, so every clone and worktree uses the board.\nThe slug is the board\'s URL part: lowercase letters, digits and dashes.',
  flags: ['name'],
  flagHelp: [['--name N', 'The board\'s name (default: from the folder name)']],
  examples: ['pm init my-repo'],
  // 0.x wrote pm.config.json and a data folder. 1.x creates the board on the server and writes
  // .pm.json, which names it. A board that exists is linked, so a second clone or a repo whose
  // board was imported needs only `pm init <slug>`.
  async run() {
    const slug = positional[0];
    if (!slug) {
      usageError('Usage: pm init <slug> [--name "Board name"]\n' +
        'The slug is the board\'s URL part: lowercase letters, digits and dashes.');
    }
    const targetDir = process.cwd();
    const boardPathOnDisk = join(targetDir, BOARD_FILENAME);
    if (existsSync(boardPathOnDisk)) {
      process.stderr.write(`${BOARD_FILENAME} already exists in ${targetDir}\n`);
      process.exit(1);
    }
    const dirName = basename(targetDir) || 'My Project';
    const name = flags.name && flags.name !== 'true'
      ? flags.name
      : dirName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    let result;
    try {
      result = await httpJson('POST', `${BASE_URL}/api/boards`, { slug, name });
    } catch (err) {
      process.stderr.write(`Failed: ${err.message}\nCannot reach the pm server at ${BASE_URL}.\n`);
      process.exit(1);
    }
    if (result.status === 201) {
      process.stdout.write(`Created board "${result.data.name}" (${slug}) on ${BASE_URL}\n`);
    } else if (result.status === 409) {
      process.stdout.write(`Board ${slug} already exists on ${BASE_URL}: linked to it\n`);
    } else {
      process.stderr.write(`Error ${result.status}: ${JSON.stringify(result.data)}\n`);
      if (result.status === 401) {
        process.stderr.write(`Creating a board needs a token: set PM_TOKEN or "token" in ${USER_CONFIG_PATH}.\n`);
      }
      process.exit(1);
    }
    writeFileSync(boardPathOnDisk, JSON.stringify({ board: slug }, null, 2) + '\n');
    process.stdout.write(`Wrote ${BOARD_FILENAME}. Commit it, so every clone and worktree uses this board.\n`);
    process.stdout.write(`Dashboard: ${BASE_URL}/${slug}\n`);
  },
};

// A rename is rare (DD-035), so the help leaves it out (DD-028).
const boardRename = {
  name: 'board-rename', write: true, group: 'Setup', hidden: true,
  synopsis: 'board-rename <new-slug> [--name N]', usage: 'board-rename [<new-slug>] [--name "Board name"]',
  summary: 'Give this board a new slug, a new name or both; the old slug still works',
  help: 'Renames the board that .pm.json (or --board) names. The old slug stays an alias: reads,\nwrites and the dashboard at /<old-slug> still reach the board, and pm prints a hint to update\n.pm.json. Keys, bodies and links inside the board do not change. A slug that another board\nhas, as its slug or an old slug, is refused.',
  flags: ['name'],
  flagHelp: [['--name N', 'The board\'s new name']],
  examples: ['pm board-rename makron --name Makron', 'pm board-rename --name "Makron"'],
  async run() {
    const body = {};
    if (positional[0]) body.slug = positional[0];
    if (flags.name !== undefined) {
      if (flags.name === 'true') usageError('--name needs a value: pm board-rename --name "Board name"');
      body.name = flags.name;
    }
    if (positional.length > 1 || !Object.keys(body).length) {
      usageError('Usage: pm board-rename [<new-slug>] [--name "Board name"]\nGive a new slug, a new name or both.');
    }
    const answer = await api('PATCH', `/api/boards/${encodeURIComponent(BOARD)}`, body, { silent: true });
    printWrite(answer, `updated board ${BOARD}: ${changes(body, answer)}`);
    if (answer?.slug && answer.slug !== BOARD) aliasHint(answer.slug);
  },
};

const update = {
  name: 'update', group: 'Setup', board: false, anyFlags: true, // its own check, below
  synopsis: 'update', usage: 'update',
  summary: 'Install the newest pm 1.x',
  help: 'Runs npm install -g @terjeballestad/pm-board-cli@1. It takes no arguments: to change a\nrecord, use pm patch.',
  async run() {
    // `pm update SB-042 --stage done` once ran npm install. A record change is pm patch.
    if (positional.length || Object.keys(flags).some(f => !['server', 'board'].includes(f))) {
      usageError('pm update installs the newest pm and takes no arguments.\nTo change a record: pm patch <id> --field value');
    }
    process.stdout.write('Updating @terjeballestad/pm-board-cli (1.x line)...\n');
    try {
      execSync('npm install -g @terjeballestad/pm-board-cli@1', { stdio: 'inherit' });
      const newPkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf-8'));
      process.stdout.write(`Updated to v${newPkg.version}\n`);
    } catch (e) {
      process.stderr.write(`Update failed: ${e.message}\n`);
      process.exit(1);
    }
  },
};

const health = {
  name: 'health', group: 'Setup', board: false,
  synopsis: 'health', usage: 'health',
  summary: 'Whether the server answers; the CLI version and the board name',
  async run() {
    // 0.x answered {status, version, project}. The 1.x server answers {ok}; the CLI adds its
    // own version and the board's name, so the shape stays 0.x's.
    const server = await httpJson('GET', `${BASE_URL}/api/health`).catch((err) => {
      process.stderr.write(`Failed: ${err.message}\nCannot reach the pm server at ${BASE_URL}.\n`);
      process.exit(1);
    });
    if (server.status !== 200 || server.data?.ok !== true) {
      process.stderr.write(`Error ${server.status}: ${JSON.stringify(server.data)}\n`);
      process.exit(1);
    }
    const out = { status: 'ok', version: VERSION };
    if (BOARD) out.project = (await loadConfig())?.name;
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  },
};

// 0.x's local server. The board lives on the server now.
const gone = (name) => ({
  name, group: 'Setup', board: false, hidden: true, anyFlags: true,
  synopsis: name, usage: name, summary: 'Gone in pm 1.x: the board lives on the server',
  run() {
    process.stdout.write(`pm ${name} is gone in pm 1.x: the board lives on ${BASE_URL}, ` +
      `and its dashboard is at ${BASE_URL}/${BOARD || '<board>'}. Nothing to start or stop.\n`);
  },
});

export const COMMANDS = [
  get, list, ready, glossary,
  create, patch, comment, claim, release, archive,
  plan, nextTask, taskUpdate, taskDone,
  project,
  issue, shorthand('decision'), shorthand('concern'), shorthand('gap'), sdd, prompt, plans,
  removed('sweep', 'pm list --stage done, then pm archive <id> [<id> ...]'),
  removed('explore', 'pm project SPRINT-NNN, the project\'s overview'),
  removed('suggest', 'pm list, then pm patch <id> --sprint SPRINT-NNN to add an item to the project'),
  removed('review', 'pm get <id> for the record, and pm list decision for the decisions to check it against'),
  removed('plan-update', 'pm patch PLAN-NNN --title T --stage S --tasks @file.json'),
  removed('sdds', 'pm list sdd'), removed('designs', 'pm list sdd'), removed('sprints', 'pm project list'),
  init, boardRename, update, health, gone('serve'), gone('start'), gone('stop'),
];

/** The item types of this board, as list and create take them. */
function itemTypeWords() {
  const types = state.config?.entityTypes || { SB: { label: 'Issue' }, DD: { label: 'Decision' }, DC: { label: 'Concern' }, GAP: { label: 'Gap' }, TERM: { label: 'Term' } };
  return Object.entries(types)
    .filter(([p]) => !['SDD', 'PLAN', 'SPRINT', 'TASK', 'MILESTONE'].includes(p))
    .map(([p, d]) => String(d.label || p).toLowerCase())
    .join(', ');
}
