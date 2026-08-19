import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { countryFlag, countryName } from '../lib/country';
import Icon from './Icon';

const TITLE = 'Suggested guides for your countries';
const SUBTITLE = 'Public XMLTV guides for the countries your channels are in. Check one to see how much of your channel list it covers before adding it.';
const EMPTY = 'No public guide is known for the countries in your playlists yet.';
const NO_CHANNELS = 'Add a playlist first — suggestions follow the countries your channels are in.';
const CHECK_LABEL = 'Check';
const CHECKING_LABEL = 'Checking…';
const ADD_LABEL = 'Add';
const ADDED_LABEL = 'Added';
const SIDECAR_TITLE = 'Precision guide (sidecar)';
const SIDECAR_OFFLINE = 'Sidecar not reachable — see docker-compose.epg.yml';
const NOT_GENERATED = 'Channel list not generated yet';

// Public XMLTV guides for the countries the server sees in the user's playlists.
// Each row can be validated before it is added, so a guide that covers nothing is
// visible as such instead of being discovered later in the Live EPG panel.
export default function EpgSuggestions({ epgUrls, onAdd }) {
  const [suggestions, setSuggestions] = useState(null);
  const [results, setResults] = useState({});
  const [checking, setChecking] = useState('');
  const [sidecar, setSidecar] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .suggestEpg()
      .then((rows) => !cancelled && setSuggestions(rows))
      .catch(() => !cancelled && setSuggestions([]));
    api
      .epgSidecar()
      .then((status) => !cancelled && setSidecar(status))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const check = async (suggestion) => {
    setChecking(suggestion.url);
    try {
      const result = await api.validateEpg(suggestion.url, suggestion.country);
      setResults((current) => ({ ...current, [suggestion.url]: result }));
    } catch (err) {
      setResults((current) => ({ ...current, [suggestion.url]: { ok: false, error: err.message || String(err) } }));
    } finally {
      setChecking('');
    }
  };

  if (!suggestions) return null;

  return (
    <div className="mb-4">
      <SidecarStatus status={sidecar} />
      <h3 className="text-sm font-semibold text-on-surface mb-1">{TITLE}</h3>
      <p className="text-sm text-on-surface-variant mb-3">{SUBTITLE}</p>

      {suggestions.length === 0 ? (
        <p className="text-sm text-on-surface-variant">{EMPTY}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {suggestions.map((suggestion) => {
            const result = results[suggestion.url];
            const isChecking = checking === suggestion.url;
            const alreadyAdded = epgUrls.includes(suggestion.url);
            return (
              <li key={`${suggestion.id}-${suggestion.country}`} className="glass rounded-xl px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="text-xl leading-none shrink-0" aria-hidden="true">{countryFlag(suggestion.country)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {suggestion.name} <span className="text-on-surface-variant font-normal">· {countryName(suggestion.country)}</span>
                  </p>
                  <p className="text-xs font-mono text-on-surface-variant truncate" title={suggestion.url}>{suggestion.url}</p>
                  {result && <MatchSummary result={result} />}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => check(suggestion)}
                    disabled={isChecking}
                    className="glass rounded-full px-4 py-1.5 text-sm hover:bg-white/10 transition-colors disabled:opacity-50"
                  >
                    {isChecking ? CHECKING_LABEL : CHECK_LABEL}
                  </button>
                  <button
                    onClick={() => onAdd(suggestion.url)}
                    disabled={alreadyAdded}
                    className="bg-primary text-on-primary rounded-full px-4 py-1.5 text-sm font-medium hover:scale-105 transition-transform disabled:opacity-50 disabled:hover:scale-100"
                  >
                    {alreadyAdded ? ADDED_LABEL : ADD_LABEL}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// The optional iptv-org grabber, when the compose overlay is running. Shows what
// the generated channel list covers; absent entirely when no sidecar is configured.
function SidecarStatus({ status }) {
  if (!status || !status.configured) return null;
  const summary = status.summary;
  const covered = summary
    ? `${summary.matchedChannels.toLocaleString()} of ${summary.total.toLocaleString()} channels mapped`
    : NOT_GENERATED;
  return (
    <div className="glass rounded-xl px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 mb-4">
      <Icon name={status.live ? 'hub' : 'cloud_off'} className={status.live ? 'text-primary shrink-0' : 'text-on-surface-variant shrink-0'} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{SIDECAR_TITLE}</p>
        <p className="text-xs text-on-surface-variant break-words">
          {status.live ? covered : SIDECAR_OFFLINE}
          {summary?.sites?.length > 0 && status.live && ` · ${summary.sites.length} source site(s)`}
        </p>
      </div>
    </div>
  );
}

// Result of a validation: coverage against the user's own channels, or why not.
export function MatchSummary({ result }) {
  if (!result.ok) {
    return <p className="text-xs text-error mt-1 break-words">{result.error || 'Could not load this guide.'}</p>;
  }
  if (result.total === 0) {
    return (
      <p className="text-xs text-on-surface-variant mt-1">
        {NO_CHANNELS} Guide has {result.channelCount.toLocaleString()} channels.
      </p>
    );
  }
  const tone = result.matched > 0 ? 'text-primary' : 'text-on-surface-variant';
  return (
    <p className={`text-xs mt-1 ${tone}`}>
      matches {result.matched.toLocaleString()} of {result.total.toLocaleString()} channels
      {result.matched === 0 && result.sampleUnmatched?.length > 0 && (
        <span className="text-on-surface-variant"> — e.g. {result.sampleUnmatched.slice(0, 3).join(', ')}</span>
      )}
    </p>
  );
}
