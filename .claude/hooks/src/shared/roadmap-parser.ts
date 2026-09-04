/**
 * Shared ROADMAP.md parser.
 *
 * Phase 3A consolidation of three drifted hook-local copies:
 *   - post-plan-roadmap.ts        : Recent Planning Sessions tracking, normalized priority
 *   - roadmap-completion.ts       : rawContent passthrough, "- [ ]" current variant
 *   - prd-roadmap-sync.ts         : rawSections line ranges, raw priority text, progress field
 *
 * The merged version is a strict union: every consumer can use it as a
 * drop-in replacement and ignore fields it doesn't care about.
 *
 * Section headers recognized (case-insensitive):
 *   - "## current"  (also matches "## current focus")
 *   - "## completed"
 *   - "## planned"
 *   - "## recent planning sessions"
 *
 * Anything else closes the current section.
 */

export interface RoadmapItem {
  title: string;
  description?: string;
  /** Raw priority text as it appears in markdown (e.g. "high", "low", "normal"). */
  priority?: string;
  /**
   * Normalized priority bucket: 'high' | 'medium' | 'low'.
   * Maps "high" → 'high', "low" → 'low', anything else → 'medium'.
   */
  priorityBucket?: 'high' | 'medium' | 'low';
  progress?: string;
  started?: string;
  completed?: string;
  source?: string;
}

export interface PlanningSession {
  date: string;
  title: string;
  summary?: string;
  decisions: string[];
  steps?: string[];
  verification?: string[];
  files?: string[];
  /**
   * Path to the plan file this session came from. Added 2026-09-02 for the
   * compact append block: the ROADMAP entry now points AT the plan instead of
   * paraphrasing it. Optional -- a session with no plan file simply omits the
   * `**Plan:**` line.
   *
   * The other fields above are still populated, and still read back off
   * ROADMAPs written before 2026-09-02, but as of 2026-09-03 NO write path
   * renders them: both the append path and the fresh-file path emit the
   * compact block. They survive for the session's advisory context and for
   * parsing older documents.
   */
  planPath?: string;
}

export interface RoadmapDoc {
  /** Active goal, or null if none. */
  current: RoadmapItem | null;
  /** Completed milestones, in source order. */
  completed: RoadmapItem[];
  /** Planned milestones, in source order. */
  planned: RoadmapItem[];
  /** Recent Planning Sessions block, newest first as in source. */
  sessions: PlanningSession[];
  /** Original input string, returned unmodified. */
  rawContent: string;
  /**
   * Line-range map: section name -> { start, end } (inclusive start, exclusive end).
   * Sections recorded: 'current', 'completed', 'planned', 'sessions'.
   */
  rawSections: Map<string, { start: number; end: number }>;
}

/**
 * Section keys we recognize. Header detection uses startsWith with these prefixes.
 */
const SECTION_PREFIXES: Array<{ key: string; prefix: string }> = [
  // Order matters: more specific first.
  { key: 'sessions',  prefix: '## recent planning' },
  { key: 'current',   prefix: '## current' },
  { key: 'completed', prefix: '## completed' },
  { key: 'planned',   prefix: '## planned' },
];

function detectSection(strippedLower: string): string | null {
  for (const { key, prefix } of SECTION_PREFIXES) {
    if (strippedLower.startsWith(prefix)) {
      return key;
    }
  }
  if (strippedLower.startsWith('## ')) {
    return null; // Some other ## section -- closes any active section.
  }
  return undefined as unknown as string; // sentinel: not a header line
}

function bucketize(rawPriority: string): 'high' | 'medium' | 'low' {
  const p = rawPriority.toLowerCase();
  if (p.includes('high')) return 'high';
  if (p.includes('low')) return 'low';
  return 'medium';
}

/**
 * Parse a ROADMAP.md document.
 *
 * Returns a unioned view: callers can read just the fields they need.
 * Empty/missing input yields a fully-zeroed structure (no errors thrown).
 */
export function parseRoadmap(content: string): RoadmapDoc {
  const result: RoadmapDoc = {
    current: null,
    completed: [],
    planned: [],
    sessions: [],
    rawContent: content,
    rawSections: new Map(),
  };

  if (!content) return result;

  const lines = content.split('\n');
  let section: string | null = null;
  let sectionStart = -1;

  // Helper: close the active section by recording its line range.
  const closeSection = (endLine: number) => {
    if (section && sectionStart >= 0) {
      result.rawSections.set(section, { start: sectionStart, end: endLine });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    const lower = stripped.toLowerCase();

    // --- Header detection -----------------------------------------------
    const detected = detectSection(lower);
    // detectSection returns:
    //   string  -> matched a known section (key)
    //   null    -> matched an unrelated "## " header (close active section)
    //   undefined sentinel -> not a header at all
    const isAnyH2 = stripped.startsWith('## ');
    const isKnownH2 = typeof detected === 'string';
    const isUnrelatedH2 = detected === null;

    if (isKnownH2) {
      closeSection(i);
      section = detected as string;
      sectionStart = i;
      continue;
    }
    if (isUnrelatedH2) {
      closeSection(i);
      section = null;
      sectionStart = -1;
      continue;
    }

    // --- Section content -----------------------------------------------
    if (section === 'current') {
      // **Title** form (must open AND close on same line).
      if (stripped.startsWith('**') && stripped.endsWith('**') && stripped.length >= 4) {
        const title = stripped.replace(/\*\*/g, '').trim();
        if (title.length > 0) {
          result.current = { title };
        }
        continue;
      }
      // "- [ ] Title" form (roadmap-completion).
      const checkboxCurrent = stripped.match(/^-\s*\[\s*\]\s*(.+)$/);
      if (checkboxCurrent && !result.current) {
        result.current = { title: checkboxCurrent[1].trim() };
        continue;
      }
      // Detail bullets under an existing title.
      if (result.current && stripped.startsWith('- ')) {
        const text = stripped.slice(2).trim();
        if (/^started:/i.test(text)) {
          result.current.started = text.replace(/^started:\s*/i, '').trim();
        } else if (/^progress:/i.test(text)) {
          result.current.progress = text.replace(/^progress:\s*/i, '').trim();
        } else {
          // Description: join multiple lines with "; "
          if (result.current.description) {
            result.current.description = `${result.current.description}; ${text}`;
          } else {
            result.current.description = text;
          }
        }
        continue;
      }
    }

    if (section === 'completed') {
      // - [x] title (date)?
      const m = stripped.match(/^-\s*\[x\]\s*(.+?)(?:\s*\(([^)]+)\))?$/i);
      if (m) {
        result.completed.push({
          title: m[1].trim(),
          completed: m[2] || '',
        });
      }
      continue;
    }

    if (section === 'planned') {
      // - [ ] title (priority|metadata)?
      const m = stripped.match(/^-\s*\[\s*\]\s*(.+?)(?:\s*\(([^)]+)\))?$/);
      if (m) {
        const rawPriority = m[2] || 'normal';
        result.planned.push({
          title: m[1].trim(),
          priority: rawPriority,
          priorityBucket: bucketize(rawPriority),
        });
      }
      continue;
    }

    if (section === 'sessions') {
      // ### YYYY-MM-DD: Title
      const sessHeader = stripped.match(/^###\s*(\d{4}-\d{2}-\d{2}):\s*(.+)$/);
      if (sessHeader) {
        result.sessions.push({
          date: sessHeader[1],
          title: sessHeader[2].trim(),
          decisions: [],
        });
        continue;
      }
      // - decision (within current session)
      if (result.sessions.length > 0 && stripped.startsWith('-')) {
        const last = result.sessions[result.sessions.length - 1];
        last.decisions.push(stripped.slice(1).trim());
      }
      continue;
    }

    // Suppress unused var lint
    void isAnyH2;
  }

  // Close trailing section.
  closeSection(lines.length);

  return result;
}
