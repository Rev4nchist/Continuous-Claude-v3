// Hold judgement and the decisions file. Pure: no I/O.
// A hold token ends by script in one case only: a lane token whose lane is met (done with a merged SHA, `met` of a board row).
// Every other token (a decision id, a conditional, first-flip, dave-yes, item-trigger, seat-hold, an unknown form) stays unmet.
// The seat ends such a hold by deleting the token in the map (decision G2; seat-hold is amendment A8).

export function tokenText(token) {
  if (token.kind === 'decision') return token.id;
  if (token.kind === 'conditional') return `${token.lane} if ${token.decision} = ${token.answer}`;
  if (token.kind === 'lane') return token.lane;
  if (token.kind === 'unknown') return token.text;
  return token.kind;
}

const isMet = (metById, id) => (metById instanceof Map ? metById.get(id) : metById?.[id]) === true;

// lane: { held: token[] } from parseHeld. metById: Map or object, lane id to the board row's `met`.
// Returns { held, unmet: [token text], met: [token text] }.
export function judgeHolds(lane, metById) {
  const ended = (t) => t.kind === 'lane' && isMet(metById, t.lane);
  const met = lane.held.filter(ended).map(tokenText);
  const unmet = lane.held.filter((t) => !ended(t)).map(tokenText);
  return { held: unmet.length > 0, unmet, met };
}

// decisions.md

const DP_HEADING = /^### (DP(\d+)) \(/;
const ANY_HEADING = /^#{1,6} /;
const ITEM = /^(\d+)\. (.*)$/;
const DECIDED = /^(DECIDED|NOT ASKED)\b/;

// [{ id, heading, items: [{ id, n, text, decided }] }]. An item is a numbered line directly under a '### DPn (' heading.
// Any other heading ends the section. An item is decided when its text starts with DECIDED or NOT ASKED.
export function parseDecisions(text) {
  const sections = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const head = DP_HEADING.exec(line);
    if (head) {
      cur = { id: head[1], heading: line.slice(4).trim(), items: [] };
      sections.push(cur);
    } else if (ANY_HEADING.test(line)) {
      cur = null;
    } else if (cur && ITEM.test(line)) {
      const [, n, body] = ITEM.exec(line);
      cur.items.push({ id: `${cur.id}.${n}`, n: Number(n), text: body, decided: DECIDED.test(body) });
    }
  }
  return sections;
}

// The first section with an open item: { id, heading, open: [item ids] }, or null.
export function nextDecisionPoint(decisions) {
  for (const sec of decisions) {
    const open = sec.items.filter((i) => !i.decided).map((i) => i.id);
    if (open.length) return { id: sec.id, heading: sec.heading, open };
  }
  return null;
}
