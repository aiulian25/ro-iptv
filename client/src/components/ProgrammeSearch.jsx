import { useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { useGuideTime } from '../hooks/useGuideTime';
import { canScheduleProgramme, fmtProgrammeTime, programmeSearchWindow, searchProgrammes, PROGRAMME_SEARCH_LIMIT } from '../lib/epg';
import ProgrammeModal from './ProgrammeModal';

const PAGE = 40;
const EMPTY_OVERRIDES = Object.freeze({});
// One search surface wraps both guide layouts, so hiding results preserves their
// mounted row limits and the timeline's horizontal position.
export default function ProgrammeSearch({ channels, onSelect, children }) {
  const epg = useStore(s => s.epg), loading = useStore(s => s.epgLoading);
  const overrides = useStore(s => s.settings.epgOverrides || EMPTY_OVERRIDES);
  const padding = useStore(s => s.settings.recordingPadding) || { before: 1, after: 5 };
  const schedule = useStore(s => s.scheduleRecording);
  const now = useGuideTime(), day = programmeSearchWindow(new Date(now)).from;
  const [mode, setMode] = useState('channels'), [query, setQuery] = useState(''), [days, setDays] = useState(1);
  const [limit, setLimit] = useState(PAGE), [selected, setSelected] = useState(null);
  const root = useRef(null), input = useRef(null), switchButton = useRef(null), viewport = useRef(null);
  const deferredQuery = useDeferredValue(query);
  const matches = useMemo(() => searchProgrammes(epg, channels, mode === 'programmes' ? deferredQuery : '', { at: new Date(day), days, overrides }), [epg, channels, mode, deferredQuery, day, days, overrides]);
  const results = matches.results.slice(0, limit);
  useLayoutEffect(() => {
    if (mode === 'programmes') input.current?.focus({ preventScroll: true });
    else if (viewport.current) {
      const { top, y } = viewport.current;
      root.current.closest('.scroll-area')?.scrollTo({ top });
      window.scrollTo({ top: y });
      switchButton.current?.focus({ preventScroll: true });
      viewport.current = null;
    }
  }, [mode]);
  const switchMode = next => {
    if (next === mode) return;
    if (next === 'programmes') viewport.current = { top: root.current.closest('.scroll-area')?.scrollTop || 0, y: window.scrollY };
    setMode(next);
  };
  const record = ({ channel, programme }) => {
    if (!canScheduleProgramme(programme) || Date.parse(programme.stop) <= Date.now()) return;
    setSelected(null);
    schedule({ channelId: channel.id, channelName: channel.name, channelLogo: channel.logo, url: channel.url, title: programme.title,
      httpUserAgent: channel.httpUserAgent || '', httpReferrer: channel.httpReferrer || '',
      start: new Date(Date.parse(programme.start) - padding.before * 60000).toISOString(),
      end: new Date(Date.parse(programme.stop) + padding.after * 60000).toISOString() });
  };
  // Resolve selected actions from the current source list, rather than a stale
  // snapshot if a playlist changes while its programme dialog remains open.
  const selectedChannel = selected && channels.find(channel => channel.id === selected.channel.id);
  return <div ref={root} className="flex flex-col gap-3">
    <div role="group" aria-label="EPG search mode" className="flex gap-2 flex-wrap">
      <button ref={switchButton} type="button" aria-pressed={mode === 'channels'} onClick={() => switchMode('channels')} className={`rounded-xl px-4 min-h-11 ${mode === 'channels' ? 'bg-primary text-on-primary' : 'glass'}`}>Channels</button>
      <button type="button" aria-pressed={mode === 'programmes'} onClick={() => switchMode('programmes')} className={`rounded-xl px-4 min-h-11 ${mode === 'programmes' ? 'bg-primary text-on-primary' : 'glass'}`}>Programmes</button>
    </div>
    <div hidden={mode !== 'channels'}>{children}</div>
    {mode === 'programmes' && <section aria-label="Programme search" aria-busy={query !== deferredQuery} className="flex flex-col gap-3">
      <label className="text-sm">Search programme titles or subtitles
        <input ref={input} type="search" value={query} maxLength={200} onChange={event => { setQuery(event.target.value); setLimit(PAGE); }} className="block w-full glass rounded-xl px-3 py-3 mt-1" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <label>Programme dates <select value={days} onChange={event => { setDays(Number(event.target.value)); setLimit(PAGE); }} className="glass rounded-xl p-3">
          <option value={1}>Today</option><option value={2}>Next 2 days</option>
        </select></label>
        <button type="button" onClick={() => { setQuery(''); setLimit(PAGE); switchMode('channels'); }} className="underline min-h-11 px-3">Clear</button>
      </div>
      <p className="text-sm text-on-surface-variant">Loaded guide only, across all enabled TV channels. Next 2 days covers today and tomorrow in your local time; missing guide data is not downloaded.</p>
      <p role="status" aria-live="polite">{loading && !epg ? 'Loading guide…' : !epg ? 'No guide loaded. Add a guide in Settings.' : !query.trim() ? 'Enter a title or subtitle to search.' : query !== deferredQuery ? 'Searching…' : !matches.total ? 'No matching programmes in the loaded guide for these dates.' : `${matches.total} matching airings. Showing ${results.length}${matches.total > PROGRAMME_SEARCH_LIMIT ? ` of the first ${PROGRAMME_SEARCH_LIMIT}; refine your search for more` : ''}.`}</p>
      <ul className="flex flex-col gap-2" aria-label="Programme results">
        {results.map(row => <li key={row.key}>
          <button type="button" onClick={() => setSelected(row)} aria-label={`Details: ${row.programme.title} on ${row.channel.name}`} className="glass rounded-xl p-3 text-left w-full min-h-11">
            <span className="block font-semibold break-words">{row.programme.title}</span>
            {row.programme.subTitle && <span className="block text-sm break-words">{row.programme.subTitle}</span>}
            <span className="block text-sm text-on-surface-variant break-words">{row.channel.name} · {new Date(row.programme.start).toLocaleDateString()} · {fmtProgrammeTime(row.programme)}</span>
          </button>
        </li>)}
      </ul>
      {results.length < matches.results.length && <button type="button" onClick={() => setLimit(value => value + PAGE)} className="glass rounded-xl p-3">Show more programmes</button>}
    </section>}
    <ProgrammeModal programme={selected?.programme} channel={selectedChannel || selected?.channel} onClose={() => setSelected(null)}
      onPlay={selectedChannel ? () => { onSelect(selectedChannel); setSelected(null); } : undefined}
      onRecord={selectedChannel && canScheduleProgramme(selected?.programme) && Date.parse(selected.programme.stop) > now ? () => record({ ...selected, channel: selectedChannel }) : undefined} />
  </div>;
}
