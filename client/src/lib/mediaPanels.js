export const LIVE_PANELS = [
  { id: 'countries', icon: 'public', label: 'Countries' },
  { id: 'channels', icon: 'list_alt', label: 'Channels' },
  { id: 'favourites', icon: 'star', label: 'Favourites' },
  { id: 'history', icon: 'history', label: 'History' },
  { id: 'epg', icon: 'calendar_view_day', label: 'EPG Guide' },
  { id: 'categories', icon: 'category', label: 'Categories' },
  { id: 'catchup', icon: 'replay', label: 'Catchup' },
];
const RADIO_PANELS = LIVE_PANELS.filter(item => ['channels', 'favourites'].includes(item.id));
export const panelsForView = view => view === 'live' ? LIVE_PANELS : view === 'radio' ? RADIO_PANELS : [];
