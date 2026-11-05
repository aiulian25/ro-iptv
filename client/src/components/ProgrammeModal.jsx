import Icon from './Icon';
import Dialog from './Dialog';
import { proxied } from '../lib/api';
import { fmtProgrammeTime, canScheduleProgramme } from '../lib/epg';

// Details overlay for a single EPG programme (same overlay pattern as the
// recordings playback modal). Renders nothing when no programme is selected.
export default function ProgrammeModal({ programme, channel, onPlay, onRecord, onClose }) {
  if (!programme) return null;
  const p = programme;
  const image = p.icon && /^https?:\/\//i.test(p.icon) ? proxied(p.icon) : p.icon;
  const timeRange = p.start ? fmtProgrammeTime(p) : '';

  return (
    <Dialog label={p.title} onClose={onClose}>
      <div
        className="glass-dark rounded-3xl w-full max-w-lg max-h-[85vh] overflow-y-auto scroll-area"
      >
        {image && (
          <img
            src={image}
            alt=""
            loading="lazy"
            className="w-full aspect-video object-cover rounded-t-3xl bg-surface-container-high"
          />
        )}
        <div className="p-6 flex flex-col gap-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-2xl font-semibold">{p.title}</h2>
              {p.subTitle && <p className="text-on-surface-variant">{p.subTitle}</p>}
            </div>
            <button
              onClick={onClose}
              className="text-on-surface-variant hover:text-on-surface shrink-0"
              aria-label="Close"
            >
              <Icon aria-hidden="true" name="close" className="text-3xl" />
            </button>
          </div>

          {channel && <p className="font-semibold">{channel.name} · {new Date(p.start).toLocaleDateString()}</p>}
          {channel && !onPlay && <p role="status">This channel is no longer available.</p>}
          {channel && <div className="flex flex-wrap gap-3">
            <button type="button" disabled={!onPlay} onClick={onPlay} className="glass rounded-xl px-4 min-h-11 disabled:opacity-50">Play channel</button>
            <button type="button" disabled={!onRecord} onClick={onRecord} className="glass rounded-xl px-4 min-h-11 disabled:opacity-50">Schedule recording</button>
          </div>}
          {timeRange && <p className="font-mono text-sm text-primary">{timeRange}</p>}

          {channel && canScheduleProgramme(p) && Date.parse(p.stop) <= Date.now() && <p className="text-sm text-on-surface-variant">This airing has ended; Play channel tunes the current live stream.</p>}
          {!canScheduleProgramme(p) && <p className="text-sm text-on-surface-variant">Recording unavailable until precise start and end times are known.</p>}

          {(p.episode || p.date || p.rating) && (
            <div className="flex flex-wrap gap-2 text-xs">
              {p.episode && <span className="glass rounded-full px-3 py-1">Episode {p.episode}</span>}
              {p.date && <span className="glass rounded-full px-3 py-1">{p.date}</span>}
              {p.rating && <span className="glass rounded-full px-3 py-1">Rating {p.rating}</span>}
            </div>
          )}

          {p.desc && <p className="text-on-surface-variant leading-relaxed">{p.desc}</p>}
          {p.category && <p className="text-sm text-on-surface-variant/70">{p.category}</p>}
        </div>
      </div>
    </Dialog>
  );
}
