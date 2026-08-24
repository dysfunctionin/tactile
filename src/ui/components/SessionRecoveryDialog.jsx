import { IconDownload, IconRestore, IconTrash, IconX } from "@tabler/icons-react";

export function SessionRecoveryDialog({ sessions, onRestore, onExport, onDiscard, onDismiss }) {
  if (!sessions.length) return null;
  return (
    <div className="session-recovery-layer" role="presentation">
      <section className="session-recovery-panel" role="dialog" aria-modal="true" aria-labelledby="session-recovery-title">
        <header>
          <div>
            <h2 id="session-recovery-title">Restore closed workspaces?</h2>
            <p>{sessions.length === 1 ? "One workspace was not exported." : `${sessions.length} workspaces were not exported.`}</p>
          </div>
          <button type="button" className="icon-button" aria-label="Start blank" title="Start blank" onClick={onDismiss}>
            <IconX size={18} />
          </button>
        </header>
        <ul className="session-recovery-list">
          {sessions.map((session) => (
            <li key={session.sessionId}>
              <strong>{session.workspaceLabel}</strong>
              <span>{session.closedAt ? new Date(session.closedAt).toLocaleString() : "Closed unexpectedly"}</span>
            </li>
          ))}
        </ul>
        <footer>
          <button type="button" onClick={onRestore}><IconRestore size={16} /> Restore tabs</button>
          <button type="button" onClick={onExport}><IconDownload size={16} /> Export all</button>
          <button type="button" className="is-danger" onClick={onDiscard}><IconTrash size={16} /> Discard</button>
        </footer>
      </section>
    </div>
  );
}
