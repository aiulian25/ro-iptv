import { useState } from 'react';
import Icon from './Icon';

const FALLBACK_ICON = {
  live: 'live_tv',
  radio: 'radio',
};

// Logo with graceful fallback to a kind-appropriate icon.
export default function ChannelLogo({ src, kind = 'live', className = '', rounded = 'rounded-lg' }) {
  const [errored, setErrored] = useState(false);
  const showImg = src && !errored;
  return (
    <div className={`bg-surface-container-high flex items-center justify-center overflow-hidden shrink-0 ${rounded} ${className}`}>
      {showImg ? (
        <img
          src={src}
          loading="lazy"
          alt=""
          className="w-full h-full object-contain"
          onError={() => setErrored(true)}
        />
      ) : (
        <Icon name={FALLBACK_ICON[kind] || 'tv'} className="text-on-surface-variant text-3xl" />
      )}
    </div>
  );
}
