// @ts-check
// Folds a session's event log into the state the status line and the gate
// read. Pure: no I/O, no clock — event timestamps come from the log.

/** @typedef {import('../openspec/phases.mjs').Phase} Phase */
/** @typedef {'awaiting' | 'approved' | 'rejected'} ArtifactMark */

/**
 * @typedef {object} PendingTool
 * @property {'mcp' | 'artifact'} kind
 * @property {string} toolName
 * @property {string} key       tool name + input digest; PermissionRequest carries no tool_use_id
 * @property {string} [callId]  tool_call_id; PostToolBatch reports calls by it
 * @property {string} [server]
 * @property {string} [tool]
 * @property {string} [artifact]
 * @property {string} [path]
 * @property {string} [rel]     path inside the change directory, for messages
 * @property {boolean} [gated]  the write went through the approval dialog
 * @property {number} startedAt
 * @property {boolean} awaitingApproval
 */

/**
 * @typedef {object} SessionState
 * @property {Phase | null} phase
 * @property {string | null} change
 * @property {string | null} root          OpenSpec root that holds the change
 * @property {string | null} currentArtifact
 * @property {Record<string, ArtifactMark>} marks   per artifact of the active change
 * @property {Record<string, PendingTool>} pending  by tool_use_id
 * @property {{ server: string, tool: string, durationMs: number, at: number } | null} lastMcp
 * @property {{ id: string, text: string }[]} notices  not yet shown in the feed
 * @property {boolean} ended
 * @property {number} updatedAt
 */

/** @returns {SessionState} */
export function initialState() {
  return {
    phase: null,
    change: null,
    root: null,
    currentArtifact: null,
    marks: {},
    pending: {},
    lastMcp: null,
    notices: [],
    ended: false,
    updatedAt: 0,
  };
}

/**
 * @param {SessionState} state
 * @param {any} event
 * @returns {SessionState}
 */
export function applyEvent(state, event) {
  const at = typeof event.at === 'number' ? event.at : state.updatedAt;
  const next = { ...state, updatedAt: Math.max(state.updatedAt, at) };

  switch (event.type) {
    case 'snapshot':
      return { ...initialState(), ...event.state };

    case 'session.start':
      // A resumed session gets a new Qwen process: calls in flight are gone.
      return { ...next, ended: false, pending: {}, marks: dropAwaiting(state.marks) };

    case 'session.end':
      return { ...next, ended: true, pending: {}, marks: dropAwaiting(state.marks) };

    case 'phase':
      if (!event.phase) return next;
      return { ...next, phase: event.phase, currentArtifact: null };

    case 'change':
      if (!event.change) return next;
      if (event.change === state.change) return event.root ? { ...next, root: event.root } : next;
      return { ...next, change: event.change, root: event.root ?? null, currentArtifact: null, marks: {} };

    case 'artifact.current':
      return event.artifact ? { ...next, currentArtifact: event.artifact } : next;

    case 'tool.start': {
      if (!event.toolUseId) return next;
      /** @type {PendingTool} */
      const entry = {
        kind: event.kind === 'artifact' ? 'artifact' : 'mcp',
        toolName: event.toolName ?? '',
        key: event.key ?? '',
        callId: event.callId,
        server: event.server,
        tool: event.tool,
        artifact: event.artifact,
        path: event.path,
        rel: event.rel,
        gated: event.gated === true,
        startedAt: at,
        awaitingApproval: false,
      };
      const pending = { ...state.pending, [event.toolUseId]: entry };
      if (entry.kind === 'artifact' && entry.artifact) {
        return { ...next, pending, currentArtifact: entry.artifact };
      }
      return { ...next, pending };
    }

    case 'tool.awaiting': {
      const id = latestPending(state.pending, (p) => p.key === event.key && !p.awaitingApproval);
      if (!id) return next;
      const entry = { ...state.pending[id], awaitingApproval: true };
      const marks = entry.kind === 'artifact' && entry.artifact ? { ...state.marks, [entry.artifact]: /** @type {ArtifactMark} */ ('awaiting') } : state.marks;
      return { ...next, pending: { ...state.pending, [id]: entry }, marks };
    }

    case 'tool.end': {
      const entry = state.pending[event.toolUseId];
      if (!entry) return next;
      const { [event.toolUseId]: _done, ...pending } = state.pending;
      if (entry.kind === 'mcp') {
        const lastMcp = { server: entry.server ?? '', tool: entry.tool ?? '', durationMs: Number(event.durationMs ?? at - entry.startedAt), at };
        return { ...next, pending, lastMcp };
      }
      if (!entry.artifact) return { ...next, pending };
      if (event.ok) {
        return {
          ...next,
          pending,
          marks: { ...state.marks, [entry.artifact]: 'approved' },
          currentArtifact: state.currentArtifact === entry.artifact ? null : state.currentArtifact,
        };
      }
      // The tool failed (e.g. edit did not match); approval is moot.
      return { ...next, pending, marks: unmark(state.marks, entry.artifact, 'awaiting') };
    }

    case 'tool.cancelled':
    case 'tool.denied': {
      const id = event.callId
        ? latestPending(state.pending, (p) => p.callId === event.callId)
        : latestPending(state.pending, (p) => p.key === event.key);
      if (!id) return next;
      const { [id]: entry, ...pending } = state.pending;
      if (entry.kind === 'artifact' && entry.artifact) {
        // A rejected write is not "being written" any more.
        const currentArtifact = state.currentArtifact === entry.artifact ? null : state.currentArtifact;
        return { ...next, pending, currentArtifact, marks: { ...state.marks, [entry.artifact]: 'rejected' } };
      }
      return { ...next, pending };
    }

    case 'turn.end':
      return { ...next, pending: {}, marks: dropAwaiting(state.marks) };

    case 'notice':
      if (!event.id || !event.text || state.notices.some((n) => n.id === event.id)) return next;
      return { ...next, notices: [...state.notices, { id: event.id, text: event.text }] };

    case 'notice.flushed': {
      const ids = new Set(event.ids ?? []);
      return { ...next, notices: state.notices.filter((n) => !ids.has(n.id)) };
    }

    default:
      return next;
  }
}

/**
 * @param {Iterable<any>} events
 * @returns {SessionState}
 */
export function reduce(events) {
  let state = initialState();
  for (const event of events) state = applyEvent(state, event);
  return state;
}

/**
 * @param {Record<string, PendingTool>} pending
 * @param {(p: PendingTool) => boolean} predicate
 */
function latestPending(pending, predicate) {
  let best = null;
  for (const [id, entry] of Object.entries(pending)) {
    if (predicate(entry) && (best === null || entry.startedAt >= pending[best].startedAt)) best = id;
  }
  return best;
}

/** @param {Record<string, ArtifactMark>} marks */
function dropAwaiting(marks) {
  return Object.fromEntries(Object.entries(marks).filter(([, mark]) => mark !== 'awaiting'));
}

/**
 * @param {Record<string, ArtifactMark>} marks
 * @param {string} artifact
 * @param {ArtifactMark} mark
 */
function unmark(marks, artifact, mark) {
  if (marks[artifact] !== mark) return marks;
  const { [artifact]: _gone, ...rest } = marks;
  return rest;
}
