import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { api } from '../lib/api';
import { countryFlag, countryName } from '../lib/country';
import Icon from './Icon';
import EpgLinkButton from './EpgLinkButton';

const TITLE = 'EPG coverage';
const SUBTITLE = 'Guide links and schedule availability are counted separately. A link can exist without programmes in the loaded window (7 days back, 2 days ahead). Your manual choice stays in place even if its target disappears.';
const NO_GUIDE = 'No guide data yet — add a source above.';
const UNMATCHED_HEADING = 'Unmatched channels';
const MANUAL_LINKS = 'Manual links';
const UNLINK = 'Unlink';
const UNDEFINED_COUNTRY = 'No country detected';
const ALT_NAMES_PENDING = 'Alternative-name matching is still loading its dataset — coverage may improve shortly.';
const EMPTY_OVERRIDES = Object.freeze({});

// Colour the bar by how good the coverage is, using the existing role colours.
function barTone(pct) {
  if (pct >= 80) return 'bg-primary';
  if (pct >= 40) return 'bg-secondary';
  return 'bg-error';
}

// Per-country coverage with the misses expandable into a to-do list. The counts
// come from the server so they agree with what the guide will actually resolve.
export default function EpgCoverage() {
  const storedOverrides = useStore((s) => s.settings.epgOverrides);
  const overrides = storedOverrides || EMPTY_OVERRIDES;
  // A synced/settings replacement can have a new object with identical links.
  // Coverage depends on the effective map, not that object's reference/order.
  const overridesKey = JSON.stringify(Object.keys(overrides).sort().map((id) => [id, overrides[id]]));
  const applySettings = useStore((s) => s.applySettings);
  const sourceRevision = useStore((s) => s.epgSourceRevision);
  const guideRevision = useStore((s) => s.epg?.guideRevision);
  const saving = useStore((s) => s.settingsSaving);
  const channels = useStore((s) => s.channels);
  const [coverage, setCoverage] = useState(null);
  const [expanded, setExpanded] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .epgCoverage()
      .then((value) => { if (!cancelled) setCoverage(value); })
      .catch(() => { if (!cancelled) setCoverage(null); });
    // No automatic retry loop. A new map or mount starts one intended load;
    // an older response cannot replace coverage for a newer map/unmounted view.
    return () => { cancelled = true; };
  }, [overridesKey, sourceRevision, guideRevision]);

  const unlink = (channelId) => {
    const next = { ...overrides };
    delete next[channelId];
    void applySettings({ epgOverrides: next }).catch(() => {});
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
                      Guide links matched {row.matched.toLocaleString()} of {row.total.toLocaleString()} · {row.pct}%
                    </p>
                    <p className="text-xs text-on-surface-variant">
                      {row.scheduled == null ? 'Schedule count unavailable' : `${row.scheduled.toLocaleString()} with programmes in loaded window`}
                      {row.missingLinks > 0 && ` · ${row.missingLinks} missing manual target(s)`}
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
                          {channel.status === 'missing-target' && <span className="text-xs text-error">Manual target missing: {channel.targetKey}</span>}
                          <EpgLinkButton channel={findChannel(channels, channel.id) || channel} label={channel.status === 'missing-target' ? 'Repair link' : 'Link EPG'} />
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
                <span className="text-xs text-on-surface-variant">
                  {linkStatus(coverage, channelId, overrides[channelId])}
                </span>
                <EpgLinkButton channel={findChannel(channels, channelId) || { id: channelId, name: channelId }} label="Repair link" />
                <button
                  disabled={saving} onClick={() => unlink(channelId)}
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

function linkStatus(coverage, channelId, target) {
  const link = coverage?.links?.find((entry) => entry.channelId === channelId && entry.targetKey === target);
  if (!link) return 'Coverage status unavailable';
  if (link.status === 'missing-target') return 'Manual target missing — repair or unlink';
  return link.hasProgrammes ? 'Linked · schedule available' : 'Linked · no programmes in loaded window';
}
