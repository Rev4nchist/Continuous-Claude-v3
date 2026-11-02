/**
 * kanban-place -- where each lane sits on the board's Priorities kanban.
 *
 * ONE SOURCE, TWO SURFACES. render-board.mjs imports this to draw the first
 * frame on the server, and also inlines this function's source text into the
 * page, where it re-places the cards once the artifact db answers. The tests
 * import the very same function, so no copy of the logic exists anywhere.
 * For that reason the function must stay self-contained: no imports, no
 * outer-scope names, no modern-only syntax (it runs in a browser as-is).
 *
 * doc   : the saved `kanban/board` value, { columns: { now, next, later, waiting } }.
 *         null, undefined or malformed means "nothing saved yet".
 * lanes : [{ id, state, priority }] for every lane, done ones included.
 *
 * Returns { now, next, later, waiting, inProgress }, each a list of lane ids.
 *  - The four columns are Dave's order. Doc order wins, doc column wins.
 *  - Ids in the doc that match no open lane are dropped.
 *  - An active lane is never in the four columns: it is in `inProgress`.
 *  - A done lane is nowhere.
 *  - A lane the doc does not place goes to the END of its default column:
 *    state ready -> next, anything else -> later. Defaults sort by DB
 *    priority, then by input order.
 */
function placeLanes(doc, lanes) {
  var names = ['now', 'next', 'later', 'waiting'];
  var out = { now: [], next: [], later: [], waiting: [], inProgress: [] };
  var byId = {};
  var open = [];
  var i;
  var j;
  for (i = 0; i < lanes.length; i++) {
    if (lanes[i].state !== 'done') {
      byId[lanes[i].id] = lanes[i];
      open.push({ lane: lanes[i], at: i });
    }
  }
  open.sort(function (a, b) {
    var pa = typeof a.lane.priority === 'number' ? a.lane.priority : Infinity;
    var pb = typeof b.lane.priority === 'number' ? b.lane.priority : Infinity;
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a.at - b.at;
  });

  var placed = {};
  var cols = doc && typeof doc === 'object' && doc.columns && typeof doc.columns === 'object' ? doc.columns : {};
  for (i = 0; i < names.length; i++) {
    var ids = Array.isArray(cols[names[i]]) ? cols[names[i]] : [];
    for (j = 0; j < ids.length; j++) {
      var id = ids[j];
      if (typeof id !== 'string' || placed[id] || !Object.prototype.hasOwnProperty.call(byId, id)) continue;
      if (byId[id].state === 'active') continue;
      placed[id] = true;
      out[names[i]].push(id);
    }
  }

  for (i = 0; i < open.length; i++) {
    var l = open[i].lane;
    if (l.state === 'active') { out.inProgress.push(l.id); continue; }
    if (placed[l.id]) continue;
    out[l.state === 'ready' ? 'next' : 'later'].push(l.id);
  }
  return out;
}

export { placeLanes };
