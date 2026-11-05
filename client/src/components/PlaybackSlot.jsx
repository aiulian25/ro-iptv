const navigation = new WeakMap();

// A view owns layout and its visible-list navigation, never media lifetime.
export default function PlaybackSlot({ kind, onPrev, onNext, children }) {
  return <div data-playback-slot={kind} className="w-full h-full" ref={node => {
    if (node) navigation.set(node, { onPrev, onNext });
  }}>{children}</div>;
}

export function playbackNavigationFor(kind) {
  const slot = document.querySelector(`[data-playback-slot="${kind}"]`);
  return slot ? navigation.get(slot) : null;
}
