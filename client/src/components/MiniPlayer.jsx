import Icon from './Icon';
import ChannelLogo from './ChannelLogo';
import PreviousChannelButton from './PreviousChannelButton';

// Presentation only. The owning full player keeps its media element and stream.
export default function MiniPlayer({ channel, playing, muted, onPrev, onNext, onStop, onTogglePlay, onToggleMute, onTogglePip, onExpand }) {
  const radio = channel.kind === 'radio';
  const controls = <>
    <PreviousChannelButton />
    <button data-no-drag onClick={onPrev} aria-label="Previous" className="p-1.5 hover:text-primary"><Icon name="skip_previous" /></button>
    <button data-no-drag onClick={onTogglePlay} aria-label={playing ? 'Pause' : 'Play'} className="p-1.5 hover:text-primary"><Icon name={playing ? 'pause' : 'play_arrow'} fill /></button>
    <button data-no-drag onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'} className="p-1.5"><Icon name={muted ? 'volume_off' : 'volume_up'} /></button>
    <button data-no-drag onClick={onNext} aria-label="Next" className="p-1.5 hover:text-primary"><Icon name="skip_next" /></button>
    {!radio && document.pictureInPictureEnabled && <button data-no-drag onClick={onTogglePip} aria-label="Picture in picture" className="p-1.5"><Icon name="picture_in_picture_alt" /></button>}
    <button data-no-drag onClick={onExpand} aria-label="Open full player" className="p-1.5"><Icon name="open_in_full" /></button>
    <button data-no-drag onClick={onStop} aria-label="Stop" className="p-1.5 hover:text-error"><Icon name="close" /></button>
  </>;
  if (radio) return <div className="mx-auto max-w-3xl glass-dark rounded-2xl border border-white/10 shadow-2xl flex flex-wrap items-center gap-2 p-2 text-on-surface">
    <ChannelLogo src={channel.logo} kind="radio" className="w-16 h-12" rounded="rounded-lg" />
    <button onClick={onExpand} className="flex-1 min-w-0 text-left"><span className="block text-sm font-semibold truncate">{channel.name}</span><span className="text-xs text-on-surface-variant">Radio</span></button>{controls}
  </div>;
  return <div className="absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/70 via-transparent to-black/40 text-white">
    <span className="text-xs truncate p-2">{channel.name}</span>
    <div className="flex flex-wrap justify-center items-center gap-1 pb-1">{controls}</div>
  </div>;
}
