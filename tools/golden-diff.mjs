// The comparison of the golden write checks: compare-read's rules (as data, an empty list equals a
// missing one), plus two for writes. A time or comment id made during the run only has to be new on
// both sides, and a time inside a text counts as the same when both are new. `start` is when the
// run began, in ms.
export function makeDiff(start) {
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
  const ISO_IN_TEXT = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
  const isNewTime = (s) => Date.parse(s) >= start - 1000;
  const isNewCommentId = (s) => /^c\d+$/.test(s) && Number(s.slice(1)) >= start - 1000;
  const empty = (v) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);
  const textTimes = (s) => s.replace(ISO_IN_TEXT, (t) => (isNewTime(t) ? '<new time>' : t));

  /**
   * The first difference between a (0.x) and b (1.x), or null. pa and pb are the same value after
   * the step before: a new time or comment id passes only when both sides changed it in this step,
   * or neither did.
   */
  function diff(a, b, path = '', pa, pb) {
    if (empty(a) && empty(b)) return null;
    if (typeof a === 'string' && typeof b === 'string') {
      const sameChange = (a === pa) === (b === pb);
      if (a === b) return null;
      if (ISO.test(a) && ISO.test(b)) {
        return Date.parse(a) === Date.parse(b) || (isNewTime(a) && isNewTime(b) && sameChange) ? null : { path, a, b };
      }
      if (path.endsWith('.id') && isNewCommentId(a) && isNewCommentId(b) && sameChange) return null;
      return textTimes(a) === textTimes(b) ? null : { path, a, b };
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return { path: path + '.length', a: a.length, b: b.length };
      for (let i = 0; i < a.length; i++) {
        const d = diff(a[i], b[i], `${path}[${i}]`, pa?.[i], pb?.[i]);
        if (d) return d;
      }
      return null;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const d = diff(a[k], b[k], `${path}.${k}`, pa?.[k], pb?.[k]);
        if (d) return d;
      }
      return null;
    }
    return JSON.stringify(a) === JSON.stringify(b) ? null : { path, a, b };
  }

  /** Lists compare by id, as in compare-read: the order of files on disk is not a contract. */
  function diffList(a, b, path, pa, pb) {
    if (!Array.isArray(a) || !Array.isArray(b)) return diff(a, b, path, pa, pb);
    const byId = new Map(b.map((x) => [x.id, x]));
    const prevA = new Map((Array.isArray(pa) ? pa : []).map((x) => [x.id, x]));
    const prevB = new Map((Array.isArray(pb) ? pb : []).map((x) => [x.id, x]));
    for (const x of a) {
      const d = byId.has(x.id)
        ? diff(x, byId.get(x.id), `${path}/${x.id}`, prevA.get(x.id), prevB.get(x.id))
        : { path: `${path}/${x.id}`, a: 'present', b: 'missing' };
      if (d) return d;
    }
    const ids = new Set(a.map((x) => x.id));
    const extra = b.filter((y) => !ids.has(y.id)).map((y) => y.id);
    return extra.length ? { path, a: 'missing', b: extra } : null;
  }

  return { diff, diffList, textTimes };
}
