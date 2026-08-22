import { useMemo, useState } from "react";
import { IconBrackets, IconExternalLink, IconReload } from "@tabler/icons-react";
import { ObjectHeader } from "../../components/ObjectHeader.jsx";
import { ObjectGlyph } from "../../components/ObjectGlyph.jsx";
import { useLocalDraft } from "../../components/localEditSession.js";
import { useSitePreview } from "../../components/useSitePreview.js";
import { bareUrlTitle, isBareUrlValue } from "../../model.js";

export function LinkObject({
  object,
  spatialPhase,
  path,
  saveState,
  onUpdateObject,
  onBack,
  canGoBack,
  workspaceActions,
  onReparentObject,
  onOpenExternal,
}) {
  const url = object.url || "";
  const host = useMemo(() => bareUrlTitle(url), [url]);
  const [loaded, setLoaded] = useState(false);
  const urlDraft = useLocalDraft(url, (next) => {
    const trimmed = String(next || "").trim();
    if (trimmed && isBareUrlValue(trimmed)) onUpdateObject?.({ url: trimmed });
  });

  const commitUrl = () => {
    const trimmed = String(urlDraft.draftRef.current || "").trim();
    if (trimmed && isBareUrlValue(trimmed)) urlDraft.commitDraft(trimmed);
    else urlDraft.cancelDraft();
  };

  const { src, loading, error, reload } = useSitePreview({ url });

  return (
    <article className="object-surface link-object" data-object-type="link" data-spatial-phase={spatialPhase}>
      <ObjectHeader
        object={object}
        path={path}
        saveState={saveState}
        onChange={onUpdateObject}
        onBack={onBack}
        canGoBack={canGoBack}
        workspaceActions={workspaceActions}
        onReparentObject={onReparentObject}
      />

      <main className="link-workspace">
        <div className="link-toolbar" aria-label="Link controls">
          <button
            type="button"
            className="link-tool-button"
            onClick={reload}
            disabled={!url || loading}
            data-tooltip="Reload page"
          >
            <IconReload size={13} stroke={1.6} /> Reload
          </button>
          <label className="link-url-field">
            <span className="visually-hidden">Link address</span>
            <input
              value={urlDraft.draft}
              onChange={(event) => urlDraft.updateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitUrl();
                  event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  urlDraft.cancelDraft();
                  event.currentTarget.blur();
                }
              }}
              onBlur={commitUrl}
              spellCheck="false"
            />
          </label>
          <button
            type="button"
            className="link-tool-button"
            onClick={() => onOpenExternal?.(url)}
            disabled={!url}
            data-tooltip="Open in your system browser"
          >
            <IconExternalLink size={13} stroke={1.6} /> Open in browser
          </button>
        </div>
        <div className="link-stage">
          {url ? (
            src ? (
              <>
                {loading && !loaded ? <div className="link-loading" aria-hidden="true" /> : null}
                <iframe
                  key={src}
                  title={object.title}
                  src={src}
                  referrerPolicy="no-referrer"
                  allow="autoplay; clipboard-write; encrypted-media; fullscreen; geolocation; microphone; camera"
                  onLoad={() => setLoaded(true)}
                />
              </>
            ) : (
              <div className="link-empty-state">
                <ObjectGlyph item={object} size={29} stroke={1.3} />
                <h2>{loading ? "Loading…" : error ? "Unable to open this address" : "No address yet"}</h2>
                <p>
                  {error
                    ? error
                    : "Enter an http or https address above to open it inside Tactile."}
                </p>
              </div>
            )
          ) : (
            <div className="link-empty-state">
              <ObjectGlyph item={object} size={29} stroke={1.3} />
              <h2>No address yet</h2>
              <p>Enter an http or https address above to open it inside Tactile.</p>
            </div>
          )}
        </div>
      </main>

      <footer className="object-statusbar">
        <span className="status-spacer" />
        <span className="status-item"><ObjectGlyph item={object} size={14} stroke={1.55} /> Link{host ? ` · ${host}` : ""}</span>
        <span className="status-divider">·</span>
        <span className="status-item keyboard-hint"><IconBrackets size={14} stroke={1.6} /> <kbd>[</kbd> out</span>
      </footer>
    </article>
  );
}