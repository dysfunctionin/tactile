import { useEffect, useState } from "react";
import { IconCheck, IconRestore, IconTrash, IconX } from "@tabler/icons-react";

export function SessionRecoveryDialog({ sessions, onRestore, onDiscard, onDismiss }) {
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  useEffect(() => {
    const availableIds = new Set(sessions.map((session) => session.sessionId));
    setSelectedIds((current) => new Set([...current].filter((sessionId) => availableIds.has(sessionId))));
  }, [sessions]);

  if (!sessions.length) return null;
  const selectedCount = selectedIds.size;
  const toggleSession = (sessionId) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  return (
    <div className="session-recovery-layer" role="presentation">
      <section className="session-recovery-panel" role="dialog" aria-modal="true" aria-labelledby="session-recovery-title">
        <header>
          <span className="session-recovery-mark" aria-hidden="true"><IconRestore size={19} stroke={1.7} /></span>
          <div className="session-recovery-heading">
            <h2 id="session-recovery-title">Restore closed workspaces?</h2>
            <p>{sessions.length === 1 ? "1 workspace available" : `${sessions.length} workspaces available`}</p>
          </div>
          <button type="button" className="icon-button" aria-label="Start blank" title="Start blank" onClick={onDismiss}>
            <IconX size={18} />
          </button>
        </header>
        <ul className="session-recovery-list">
          {sessions.map((session) => (
            <li key={session.sessionId} className={selectedIds.has(session.sessionId) ? "is-selected" : ""}>
              <label>
                <input
                  type="checkbox"
                  checked={selectedIds.has(session.sessionId)}
                  onChange={() => toggleSession(session.sessionId)}
                />
                <span className="session-recovery-checkbox" aria-hidden="true">
                  {selectedIds.has(session.sessionId) ? <IconCheck size={13} stroke={2.4} /> : null}
                </span>
                <span className="session-recovery-workspace">
                  <strong>{session.workspaceLabel}</strong>
                  <span>{session.closedAt ? new Date(session.closedAt).toLocaleString() : "Closed unexpectedly"}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <footer>
          <button type="button" className="is-danger" onClick={onDiscard}><IconTrash size={14} /> Discard</button>
          <span className="session-recovery-action-spacer" />
          <button
            type="button"
            disabled={!selectedCount}
            onClick={() => onRestore([...selectedIds])}
          >
            <IconRestore size={14} /> Restore Selected ({selectedCount})
          </button>
          <button
            type="button"
            className="is-primary"
            onClick={() => onRestore(sessions.map((session) => session.sessionId))}
          >
            <IconRestore size={14} /> Restore All
          </button>
        </footer>
      </section>
    </div>
  );
}
