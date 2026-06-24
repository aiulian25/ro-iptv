import { useStore } from '../store/useStore';
import Icon from './Icon';

export default function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] glass-dark rounded-full px-5 py-3 flex items-center gap-2 animate-fade-in shadow-2xl">
      <Icon name="info" className="text-primary" />
      <span className="text-sm">{toast}</span>
    </div>
  );
}
