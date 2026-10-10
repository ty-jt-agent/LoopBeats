import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

export type SettingsGroup = 'Session' | 'Audio' | 'Preferences';
const groups: readonly SettingsGroup[] = ['Session', 'Audio', 'Preferences'];

export function SettingsPanel({
  open,
  group,
  onGroup,
  onClose,
  children,
  selectedTabRef,
  backgroundRef,
}: {
  open: boolean;
  group: SettingsGroup;
  onGroup: (group: SettingsGroup) => void;
  onClose: () => void;
  children: Record<SettingsGroup, ReactNode>;
  selectedTabRef: RefObject<HTMLButtonElement | null>;
  backgroundRef: RefObject<HTMLDivElement | null>;
}) {
  const panel = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.('(max-width: 1023px)').matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 1023px)');
    if (!media) return;
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (open)
      panel.current
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.focus();
  }, [open]);
  useEffect(() => {
    if (!open || !narrow) return;
    const background = backgroundRef.current;
    background?.setAttribute('inert', '');
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const containFocus = (event: FocusEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (!panel.current?.contains(event.target as Node))
        panel.current
          ?.querySelector<HTMLElement>('[aria-selected="true"]')
          ?.focus();
    };
    document.addEventListener('focusin', containFocus);
    if (
      !panel.current?.contains(document.activeElement) &&
      !document.querySelector('dialog[open]')
    )
      panel.current
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.focus();
    return () => {
      background?.removeAttribute('inert');
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('focusin', containFocus);
    };
  }, [open, narrow, backgroundRef]);
  return (
    <section
      ref={panel}
      id="settings-panel"
      className="settings-panel"
      hidden={!open}
      role={narrow ? 'dialog' : 'region'}
      aria-modal={narrow ? true : undefined}
      aria-labelledby="settings-heading"
      onKeyDown={(event) => {
        if (document.querySelector('dialog[open]')) return;
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
        if (narrow && event.key === 'Tab') {
          const controls = Array.from(
            panel.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
            ) ?? [],
          ).filter(
            (element) =>
              element.tabIndex !== -1 && element.getClientRects().length > 0,
          );
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <header className="settings-header">
        <h2 id="settings-heading">Settings</h2>
        <button onClick={onClose} aria-label="Close Settings">
          Close
        </button>
      </header>
      <div className="settings-body">
        <div
          role="tablist"
          aria-label="Settings groups"
          className="settings-tabs"
        >
          {groups.map((name, index) => (
            <button
              key={name}
              ref={group === name ? selectedTabRef : undefined}
              role="tab"
              id={`settings-tab-${name}`}
              aria-controls={`settings-group-${name}`}
              aria-selected={group === name}
              tabIndex={group === name ? 0 : -1}
              onClick={() => onGroup(name)}
              onKeyDown={(event) => {
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? 2
                      : event.key === 'ArrowRight'
                        ? (index + 1) % 3
                        : event.key === 'ArrowLeft'
                          ? (index + 2) % 3
                          : null;
                if (next === null) return;
                event.preventDefault();
                onGroup(groups[next]);
                document
                  .getElementById(`settings-tab-${groups[next]}`)
                  ?.focus();
              }}
            >
              {name}
            </button>
          ))}
        </div>
        {groups.map((name) => (
          <div
            key={name}
            role="tabpanel"
            id={`settings-group-${name}`}
            aria-labelledby={`settings-tab-${name}`}
            hidden={group !== name}
          >
            {children[name]}
          </div>
        ))}
      </div>
    </section>
  );
}
