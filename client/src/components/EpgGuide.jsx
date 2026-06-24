import { useStore, epgSources } from '../store/useStore';
import { programmesForChannel, findNowNext, fmtTime, progressPct } from '../lib/epg';
import ChannelLogo from './ChannelLogo';
import Icon from './Icon';

// Scrollable per-channel programme guide with Now/Next + record markers.
export default function EpgGuide({ channels, onSelect }) {
  const epg = useStore((s) => s.epg);
  const epgLoading = useStore((s) => s.epgLoading);
  const sources = useStore((s) => epgSources(s.settings));
  const scheduleRecording = useStore((s) => s.scheduleRecording);
  const recordings = useStore((s) => s.recordings);

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
      {channels.slice(0, 60).map((c) => {
        const progs = programmesForChannel(epg, c);
        const { now } = findNowNext(progs);
        const upcoming = progs
          .filter((p) => p.stop && new Date(p.stop) > new Date())
          .slice(0, 6);
        return (
          <div key={c.id} className="glass rounded-xl p-3">
            <div className="flex items-center gap-3 mb-2 cursor-pointer" onClick={() => onSelect(c)}>
              <ChannelLogo src={c.logo} kind={c.kind} className="w-12 h-9" />
              <div className="min-w-0">
                <h3 className="font-semibold truncate">{c.name}</h3>
                {now && (
                  <div className="h-1 w-40 max-w-full bg-surface-variant rounded-full overflow-hidden mt-1">
                    <div className="bg-primary h-full" style={{ width: `${progressPct(now)}%` }} />
                  </div>
                )}
              </div>
            </div>
            <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
              {upcoming.length ? (
                upcoming.map((p, i) => {
                  const isNow = now && p.start === now.start;
                  const isRec = recordings.some((r) => r.channelName === c.name && r.title === p.title);
                  return (
                    <div
                      key={i}
                      className={`shrink-0 w-44 rounded-lg p-2.5 border ${
                        isNow ? 'border-primary bg-primary/10' : 'border-white/10 bg-white/5'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] text-on-surface-variant">
                          {fmtTime(p.start)}–{fmtTime(p.stop)}
                        </span>
                        <button
                          onClick={() =>
                            scheduleRecording({
                              channelId: c.id,
                              channelName: c.name,
                              channelLogo: c.logo,
                              url: c.url,
                              title: p.title,
                              start: p.start,
                              end: p.stop,
                            })
                          }
                          className={isRec ? 'text-error' : 'text-on-surface-variant hover:text-error'}
                          title="Schedule recording"
                        >
                          <Icon name="fiber_manual_record" className="text-base" />
                        </button>
                      </div>
                      <p className="text-sm font-medium mt-1 line-clamp-2">{p.title}</p>
                    </div>
                  );
                })
              ) : (
                <p className="text-sm text-on-surface-variant py-2">No schedule for this channel.</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
