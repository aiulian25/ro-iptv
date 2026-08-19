import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { api } from '../lib/api';
import { countryFlag, countryName } from '../lib/country';
import Icon from './Icon';
import EpgLinkButton from './EpgLinkButton';

const TITLE = 'EPG coverage';
const SUBTITLE = 'How much of your channel list the loaded guides actually resolve. Link anything that missed — your choice wins over automatic matching and follows you to your other devices.';
const NO_GUIDE = 'No guide data yet — add a source above.';
const UNMATCHED_HEADING = 'Unmatched channels';
const MANUAL_LINKS = 'Manual links';
const UNLINK = 'Unlink';
const UNDEFINED_COUNTRY = 'No country detected';
const ALT_NAMES_PENDING = 'Alternative-name matching is still loading its dataset — coverage may improve shortly.';

// Colour the bar by how good the coverage is, using the existing role colours.
function barTone(pct) {
  if (pct >= 80) return 'bg-primary';
  if (pct >= 40) return 'bg-secondary';
  return 'bg-error';
}

// Per-country coverage with the misses expandable into a to-do list. The counts
// come from the server so they agree with what the guide will actually resolve.
export default function EpgCoverage() {
  const overrides = useStore((s) => s.settings.epgOverrides || {});
  const applySettings = useStore((s) => s.applySettings);
  const channels = useStore((s) => s.channels);
  const [coverage, setCoverage] = useState(null);
  const [expanded, setExpanded] = useState('');

  const load = useCallback(() => {
    api
      .epgCoverage()
      .then(setCoverage)
      .catch(() => setCoverage(null));
  }, []);

  useEffect(load, [load]);
  // A link changes the answer, so re-ask once the change has been saved.
  useEffect(() => {
    if (coverage) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides]);

  const unlink = (channelId) => {
    const next = { ...overrides };
    delete next[channelId];
    applySettings({ epgOverrides: next });
  };

  const linkedIds = Object.keys(overrides);
  const rows = coverage?.byCountry || [];

  return (
    <div>
      <h2 className="text-lg font-semibold text-primary mb-1">{TITLE}</h2>
      <p className="text-sm text-on-surface-variant mb-3">{SUBTITLE}</p>

      {rows.length === 0 ? (
        <p className="text-sm text-on-surface-variant">{NO_GUIDE}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const isOpen = expanded === row.key;
            return (
              <li key={row.key || 'undefined'} className="glass rounded-xl px-3 py-2.5">
                <button
                  onClick={() => setExpanded(isOpen ? '' : row.key)}
                  aria-expanded={isOpen}
                  disabled={row.unmatched.length === 0}
                  className="flex items-center gap-3 w-full text-left disabled:cursor-default"
                >
                  <span className="text-xl leading-none shrink-0" aria-hidden="true">{countryFlag(row.key)}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {row.key ? countryName(row.key) : UNDEFINED_COUNTRY}
                    </p>
                    <p className="text-xs text-on-surface-variant">
                      matched {row.matched.toLocaleString()} of {row.total.toLocaleString()} · {row.pct}%
                    </p>
                    <div className="mt-1.5 h-1 w-full bg-surface-variant rounded-full overflow-hidden">
                      <div className={`h-full ${barTone(row.pct)}`} style={{ width: `${row.pct}%` }} />
                    </div>
                  </div>
                  {row.unmatched.length > 0 && (
                    <Icon name={isOpen ? 'expand_less' : 'expand_more'} className="text-on-surface-variant shrink-0" />
                  )}
                </button>

                {isOpen && (
                  <div className="mt-3">
                    <p className="font-mono text-[11px] uppercase text-on-surface-variant mb-1">{UNMATCHED_HEADING}</p>
                    <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto scroll-area">
                      {row.unmatched.map((channel) => (
                        <div key={channel.id} className="flex flex-wrap items-center gap-2 py-1 border-t border-white/5 first:border-0">
                          <span className="flex-1 min-w-0 text-sm truncate" title={channel.tvgId || channel.name}>
                            {channel.name}
                          </span>
                          <EpgLinkButton channel={findChannel(channels, channel.id) || channel} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {coverage && !coverage.altNamesAvailable && (
        <p className="text-xs text-on-surface-variant mt-2">{ALT_NAMES_PENDING}</p>
      )}

      {linkedIds.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-on-surface mb-2">
            {MANUAL_LINKS} ({linkedIds.length.toLocaleString()})
          </h3>
          <ul className="flex flex-col gap-1.5">
            {linkedIds.map((channelId) => (
              <li key={channelId} className="glass rounded-xl px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="flex-1 min-w-0 text-sm truncate" title={channelId}>
                  {findChannel(channels, channelId)?.name || channelId}
                </span>
                <span className="text-xs font-mono text-on-surface-variant truncate">→ {overrides[channelId]}</span>
                <button
                  onClick={() => unlink(channelId)}
                  className="text-on-surface-variant hover:text-error shrink-0 text-sm"
                >
                  {UNLINK}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// The live channel object, so the link picker gets the same shape it does
// elsewhere (it reads tvgId/name to seed its search).
function findChannel(channels, channelId) {
  return channels.find((channel) => channel.id === channelId);
}
