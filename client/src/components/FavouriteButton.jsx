import Icon from './Icon';
import { useStore } from '../store/useStore';

// Single source of truth for the favourite control. A favourited channel always
// shows a filled RED star; otherwise an outline star. Works on any page because
// it keys off the global favourites set by channel id. Stops propagation so it
// can sit inside clickable channel/station cards without triggering them.
export default function FavouriteButton({ channelId, variant = 'icon', size = 'text-xl', className = '' }) {
  const isFav = useStore((s) => s.favourites.includes(channelId));
  const toggleFavourite = useStore((s) => s.toggleFavourite);

  const handle = (e) => {
    e.stopPropagation();
    toggleFavourite(channelId);
  };

  const label = isFav ? 'Remove from favourites' : 'Add to favourites';

  if (variant === 'pill') {
    return (
      <button
        type="button"
        onClick={handle}
        aria-pressed={isFav}
        aria-label={label}
        className={`glass px-5 py-2.5 rounded-full flex items-center gap-2 hover:bg-white/10 transition-all ${className}`}
      >
        <Icon name="star" fill={isFav} className={isFav ? 'text-red-500' : 'text-on-surface-variant'} />
        <span className="font-mono text-xs">{isFav ? 'Favourited' : 'Favourite'}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handle}
      aria-pressed={isFav}
      aria-label={label}
      title={label}
      className={`shrink-0 transition-colors ${isFav ? 'text-red-500' : 'text-on-surface-variant/50 hover:text-red-400'} ${className}`}
    >
      <Icon name="star" fill={isFav} className={size} />
    </button>
  );
}
