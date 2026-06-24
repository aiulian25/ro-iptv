import { useState } from 'react';
import Icon from './Icon';
import { proxied } from '../lib/api';

const FALLBACK_ICON = {
  live: 'live_tv',
  radio: 'radio',
};

// Logo with graceful fallback to a kind-appropriate icon. External logos are
// fetched through the backend proxy (same-origin) — this defeats hotlink
// protection (imgur), referrer rules, mixed content and the opaque-response
// caching that otherwise stops a cross-origin <img> rendering in the browser.
export default function ChannelLogo({ src, kind = 'live', className = '', rounded = 'rounded-lg' }) {
  const [errored, setErrored] = useState(false);
  const resolved = src && /^https?:\/\//i.test(src) ? proxied(src) : src;
  const showImg = resolved && !errored;
  return (
    <div className={`bg-surface-container-high flex items-center justify-center overflow-hidden shrink-0 ${rounded} ${className}`}>
      {showImg ? (
        <img
          src={resolved}
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
