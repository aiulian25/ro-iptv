import { useMemo } from 'react';
import { selectCategoriesFor } from '../store/useStore';
import Icon from './Icon';

// Browse-by-category cards (same visual pattern as CountryGrid).
export default function CategoryGrid({ channels, onSelect }) {
  const categories = useMemo(
    () => selectCategoriesFor(channels).filter(([name]) => name !== 'All'),
    [channels]
  );

  if (!categories.length) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-on-surface-variant gap-3 text-center">
        <Icon name="category" className="text-5xl opacity-60" />
        <p>No categories here yet.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
      {categories.map(([name, count]) => (
        <button
          key={name}
          onClick={() => onSelect(name)}
          className="glass rounded-2xl p-4 flex items-center gap-3 text-left transition-all duration-300 hover:scale-[1.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Icon name="category" className="text-primary text-2xl shrink-0" />
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold truncate">{name}</h3>
            <p className="text-sm text-on-surface-variant">{count.toLocaleString()} channels</p>
          </div>
          <Icon name="chevron_right" className="text-on-surface-variant" />
        </button>
      ))}
    </div>
  );
}
