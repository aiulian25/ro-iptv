import { useState } from 'react';
import { useStore, epgSources } from '../store/useStore';
import { programmesForChannel, findNowNext, fmtTime, progressPct, epgIconFor } from '../lib/epg';
import ChannelLogo from './ChannelLogo';
import ProgrammeModal from './ProgrammeModal';
import EpgLinkButton from './EpgLinkButton';
import Icon from './Icon';

const PAGE = 60;
const MS_PER_MINUTE = 60000;
const DEFAULT_PADDING = { before: 1, after: 5 };

// Scrollable per-channel programme guide with Now/Next + record markers.
export default function EpgGuide({ channels, onSelect }) {
  const epg = useStore((s) => s.epg);
  const epgLoading = useStore((s) => s.epgLoading);
  const sources = useStore((s) => epgSources(s.settings));
  const scheduleRecording = useStore((s) => s.scheduleRecording);
  const recordings = useStore((s) => s.recordings);
  const overrides = useStore((s) => s.settings.epgOverrides || {});
  const pad = useStore((s) => s.settings.recordingPadding) || DEFAULT_PADDING;
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState(null);

  if (!epg) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-3 text-center px-6">
        <Icon name="calendar_month" className="text-5xl opacity-60" />
        {epgLoading ? (
          <p>Loading guide…</p>
        ) : sources.length ? (
          <>
            <p>No programmes for these channels.</p>
            <p className="text-sm">The guide loaded but none of its channel IDs matched. Check the EPG covers this country.</p>
          </>
        ) : (
          <>
            <p>No EPG loaded.</p>
            <p className="text-sm">Add an XMLTV guide in Settings (e.g. from iptv-org/epg) to see the schedule.</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {channels.slice(0, limit).map((c) => {
        const progs = programmesForChannel(epg, c, overrides);
        const { now } = findNowNext(progs);
        const upcoming = progs
          .filter((p) => p.stop && new Date(p.stop) > new Date())
          .slice(0, 6);
        return (
          <div key={c.id} className="glass rounded-xl p-3">
            <div className="flex items-center gap-3 mb-2 cursor-pointer" onClick={() => onSelect(c)}>
              <ChannelLogo src={c.logo || epgIconFor(epg, c)} kind={c.kind} className="w-12 h-9" />
              <div className="min-w-0">
                <h3 className="font-semibold truncate">{c.name}</h3>
                {now && (
                  <div className="h-1 w-40 max-w-full bg-surface-variant rounded-full overflow-hidden mt-1">
                    <div className="bg-primary h-full" style={{ width: `${progressPct(now)}%` }} />
                  </div>
                )}
              </div>
            </div>
            {upcoming.length ? (
              <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
                {upcoming.map((p, i) => {
                  const isNow = now && p.start === now.start;
                  const isRec = recordings.some((r) => r.channelName === c.name && r.title === p.title);
                  return (
                    <div
                      key={i}
                      onClick={() => setSelected(p)}
                      className={`shrink-0 w-44 rounded-lg p-2.5 border cursor-pointer transition-colors hover:border-white/30 ${
                        isNow ? 'border-primary bg-primary/10' : 'border-white/10 bg-white/5'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] text-on-surface-variant">
                          {fmtTime(p.start)}–{fmtTime(p.stop)}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            scheduleRecording({
                              channelId: c.id,
                              channelName: c.name,
                              channelLogo: c.logo,
                              url: c.url,
                              title: p.title,
                              start: new Date(new Date(p.start).getTime() - pad.before * MS_PER_MINUTE).toISOString(),
                              end: new Date(new Date(p.stop).getTime() + pad.after * MS_PER_MINUTE).toISOString(),
                            });
                          }}
                          className={isRec ? 'text-error' : 'text-on-surface-variant hover:text-error'}
                          title="Schedule recording"
                        >
                          <Icon name="fiber_manual_record" className="text-base" />
                        </button>
                      </div>
                      <p className="text-sm font-medium mt-1 line-clamp-2">{p.title}</p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center gap-3 flex-wrap py-2">
                <p className="text-sm text-on-surface-variant">No schedule for this channel.</p>
                <EpgLinkButton channel={c} />
              </div>
            )}
          </div>
        );
      })}
      {limit < channels.length && (
        <button
          onClick={() => setLimit((l) => l + PAGE)}
          className="glass rounded-xl py-3 text-sm text-on-surface-variant hover:text-on-surface hover:bg-white/5 transition-colors"
        >
          Show more ({limit}/{channels.length})
        </button>
      )}
      <ProgrammeModal programme={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
