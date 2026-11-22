// The knowledge-base part of `pm prompt` and `pm review` (DD-017). The 0.x server ran the
// knowledge-base command (qmd) itself and appended its output to the prompt. The 1.x server cannot
// reach the machine's knowledge base, so it answers with the queries in `qmdQueries`, and the
// client runs them and appends the results here, in 0.x's words.
//
// Pure ESM with no Node built-ins: the caller passes `run(query)`, which runs the command for one
// query and returns its output, or null when it fails.

/** `answer` from POST context/prompt: one query, appended when its output is not empty. */
export function appendPromptKnowledge(answer, run) {
  const { qmdQueries, ...rest } = answer;
  for (const q of qmdQueries ?? []) {
    const out = run(q);
    if (out && out.trim()) rest.prompt += `\n\n## Knowledge Base Context\n\n${out.trim()}`;
  }
  return rest;
}

/** `answer` from POST context/review: every query with output, under one heading. */
export function appendReviewKnowledge(answer, run) {
  const { qmdQueries, ...rest } = answer;
  const results = [];
  for (const q of qmdQueries ?? []) {
    const out = run(q);
    if (out && out.trim()) results.push({ query: q, result: out.trim() });
  }
  if (results.length > 0) {
    rest.prompt += `\n\n## Knowledge Base Context\n\n`;
    rest.prompt += `Use these references to cross-check decisions and identify misalignments:\n\n`;
    for (const r of results) rest.prompt += `### Query: "${r.query}"\n\n${r.result}\n\n`;
  }
  return rest;
}
