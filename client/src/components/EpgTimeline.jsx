import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { programmesForChannel, fmtTime } from '../lib/epg';
import { supportsCatchup } from '../lib/catchup';
import ChannelLogo from './ChannelLogo';
import ProgrammeModal from './ProgrammeModal';
import Icon from './Icon';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
// The axis: a day of history to pan back into (Catchup lives there) and two days
// ahead, which is what the merged guide serves forward.
const HOURS_PAST = 24;
const HOURS_FUTURE = 48;
const PX_PER_HOUR = 180;
const TICK_MINUTES = 30;
// A block narrower than this cannot show anything readable, so short programmes
// get a floor rather than collapsing to a sliver.
const MIN_BLOCK_PX = 48;
const CHANNEL_COLUMN_PX = 168;
const ROW_HEIGHT_PX = 56;
const PAGE = 20;
// One shared tick drives the now-line and the "on now" highlight. Deliberately
// not useClock's one second: at this scale a second is 0.05px of movement, so
// ticking that fast would re-render every row for nothing.
const TICK_MS = 30_000;
const DEFAULT_PADDING = { before: 1, after: 5 };
const SCROLL_LEAD_HOURS = 1;

const startOfHour = (ms) => Math.floor(ms / MS_PER_HOUR) * MS_PER_HOUR;

// TV-style guide: channels down, time across, every programme placed on one axis
// so "what is on at nine" is a glance instead of a scroll.
export default function EpgTimeline({ channels, onSelect }) {
  const epg = useStore((s) => s.epg);
  const overrides = useStore((s) => s.settings.epgOverrides || {});
  const padding = useStore((s) => s.settings.recordingPadding) || DEFAULT_PADDING;
  const recordings = useStore((s) => s.recordings);
  const scheduleRecording = useStore((s) => s.scheduleRecording);
  const playCatchup = useStore((s) => s.playCatchup);
  const scrollRef = useRef(null);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  // Pinned on mount: a moving origin would slide every block sideways under the
  // user. The now-line moves within this fixed axis instead.
  const [axisStart] = useState(() => startOfHour(Date.now() - HOURS_PAST * MS_PER_HOUR));
  const axisEnd = axisStart + (HOURS_PAST + HOURS_FUTURE) * MS_PER_HOUR;
  const axisWidth = (HOURS_PAST + HOURS_FUTURE) * PX_PER_HOUR;
  const offsetOf = (ms) => ((ms - axisStart) / MS_PER_HOUR) * PX_PER_HOUR;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Open on the current hour rather than a day of history.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = offsetOf(Date.now() - SCROLL_LEAD_HOURS * MS_PER_HOUR);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ticks = useMemo(() => {
    const marks = [];
    const step = TICK_MINUTES * MS_PER_MINUTE;
    for (let at = axisStart; at < axisEnd; at += step) marks.push(at);
    return marks;
  }, [axisStart, axisEnd]);

  const visible = useMemo(() => channels.slice(0, limit), [channels, limit]);

  if (!epg) return null;

  return (
    <div className="flex flex-col gap-3">
      <div ref={scrollRef} className="relative overflow-x-auto scroll-area glass rounded-xl">
        <div className="relative" style={{ width: CHANNEL_COLUMN_PX + axisWidth }}>
          <TimeAxis ticks={ticks} offsetOf={offsetOf} axisWidth={axisWidth} />

          {visible.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              epg={epg}
              overrides={overrides}
              axisStart={axisStart}
              axisEnd={axisEnd}
              axisWidth={axisWidth}
              offsetOf={offsetOf}
              now={now}
              padding={padding}
              recordings={recordings}
              onSelect={onSelect}
              onOpen={setSelected}
              onSchedule={scheduleRecording}
              onPlayCatchup={playCatchup}
            />
          ))}

          <NowLine left={offsetOf(now)} />
        </div>
      </div>

      {limit < channels.length && (
        <button
          onClick={() => setLimit((current) => current + PAGE)}
          className="glass rounded-xl py-3 text-sm text-on-surface-variant hover:text-on-surface hover:bg-white/5 transition-colors"
        >
          Show more ({limit}/{channels.length})
        </button>
      )}

      <ProgrammeModal programme={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

// Half-hour marks, with the day named wherever the date turns over.
function TimeAxis({ ticks, offsetOf, axisWidth }) {
  return (
    <div className="flex sticky top-0 z-30 glass-dark border-b border-white/10">
      <div
        className="sticky left-0 z-40 bg-surface-container shrink-0 border-r border-white/10"
        style={{ width: CHANNEL_COLUMN_PX }}
      />
      <div className="relative h-9" style={{ width: axisWidth }}>
        {ticks.map((at) => {
          const date = new Date(at);
          const startsDay = date.getHours() === 0 && date.getMinutes() === 0;
          return (
            <div
              key={at}
              className="absolute top-0 h-full border-l border-white/10 pl-1.5 flex items-center"
              style={{ left: offsetOf(at) }}
            >
              <span className={`font-mono text-[11px] whitespace-nowrap ${startsDay ? 'text-primary' : 'text-on-surface-variant'}`}>
                {startsDay ? date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : fmtTime(date.toISOString())}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Sits under the sticky channel column (lower z) so it never draws over a name.
function NowLine({ left }) {
  return (
    <div
      className="absolute top-0 bottom-0 w-0.5 bg-primary pointer-events-none z-10"
      style={{ left: CHANNEL_COLUMN_PX + left }}
      aria-hidden="true"
    />
  );
}

function ChannelRow({
  channel,
  epg,
  overrides,
  axisStart,
  axisEnd,
  axisWidth,
  offsetOf,
  now,
  padding,
  recordings,
  onSelect,
  onOpen,
  onSchedule,
  onPlayCatchup,
}) {
  // Only what the axis can show: the merged guide carries a week of history that
  // would otherwise be laid out and thrown away.
  const blocks = useMemo(() => {
    const programmes = programmesForChannel(epg, channel, overrides);
    return programmes
      .filter((programme) => Date.parse(programme.stop) > axisStart && Date.parse(programme.start) < axisEnd)
      .map((programme) => {
        const start = Date.parse(programme.start);
        const stop = Date.parse(programme.stop);
        return {
          programme,
          left: offsetOf(start),
          width: Math.max(MIN_BLOCK_PX, ((stop - start) / MS_PER_HOUR) * PX_PER_HOUR),
          start,
          stop,
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epg, channel, overrides, axisStart, axisEnd]);

  const archived = supportsCatchup(channel);

  return (
    <div className="flex border-b border-white/5 last:border-0">
      {/* Opaque, not glass: programme blocks scroll underneath this column, and a
          translucent background lets their text ghost through it. */}
      <button
        onClick={() => onSelect(channel)}
        className="sticky left-0 z-20 bg-surface-container shrink-0 flex items-center gap-2 px-2 text-left border-r border-white/10 hover:bg-surface-container-high transition-colors"
        style={{ width: CHANNEL_COLUMN_PX, height: ROW_HEIGHT_PX }}
      >
        <ChannelLogo src={channel.logo} kind={channel.kind} className="w-10 h-7" />
        <span className="flex-1 min-w-0 text-sm font-medium truncate">{channel.name}</span>
      </button>

      <div className="relative" style={{ width: axisWidth, height: ROW_HEIGHT_PX }}>
        {blocks.map(({ programme, left, width, start, stop }) => {
          const isNow = start <= now && now < stop;
          const isPast = stop <= now;
          const isRecording = recordings.some(
            (recording) => recording.channelName === channel.name && recording.title === programme.title
          );
          return (
            <div
              key={`${start}-${programme.title}`}
              onClick={() => onOpen(programme)}
              className={`absolute top-1 bottom-1 rounded-md px-2 py-1 border cursor-pointer overflow-hidden transition-colors group ${
                isNow ? 'border-primary bg-primary/10' : 'border-white/10 bg-white/5 hover:border-white/30'
              } ${isPast ? 'opacity-60' : ''}`}
              style={{ left, width }}
            >
              <p className="text-xs font-medium truncate">{programme.title}</p>
              <p className="font-mono text-[10px] text-on-surface-variant truncate">
                {fmtTime(programme.start)}–{fmtTime(programme.stop)}
              </p>

              <div className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                {isPast ? (
                  archived && (
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        onPlayCatchup(channel, programme);
                      }}
                      title={`Play ${programme.title} from the archive`}
                      aria-label={`Play ${programme.title} from the archive`}
                      className="text-primary hover:text-white"
                    >
                      <Icon name="replay" className="text-sm" />
                    </button>
                  )
                ) : (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onSchedule({
                        channelId: channel.id,
                        channelName: channel.name,
                        channelLogo: channel.logo,
                        url: channel.url,
                        title: programme.title,
                        httpUserAgent: channel.httpUserAgent || '',
                        httpReferrer: channel.httpReferrer || '',
                        start: new Date(start - padding.before * MS_PER_MINUTE).toISOString(),
                        end: new Date(stop + padding.after * MS_PER_MINUTE).toISOString(),
                      });
                    }}
                    title={`Schedule ${programme.title}`}
                    aria-label={`Schedule ${programme.title}`}
                    className={isRecording ? 'text-error' : 'text-on-surface-variant hover:text-error'}
                  >
                    <Icon name="fiber_manual_record" className="text-sm" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
