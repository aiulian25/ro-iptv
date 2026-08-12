import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import Icon from '../components/Icon';
import ChannelLogo from '../components/ChannelLogo';
import { api, recordingFileUrl, recordingDownloadUrl } from '../lib/api';

function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

// Map the server-side status to a label + colour.
const STATUS = {
  recording: { label: 'Recording', color: 'text-red-400', pulse: true },
  scheduled: { label: 'Scheduled', color: 'text-primary' },
  completed: { label: 'Saved', color: 'text-on-surface-variant' },
  interrupted: { label: 'Interrupted', color: 'text-secondary' },
  missed: { label: 'Missed', color: 'text-on-surface-variant' },
  failed: { label: 'Failed', color: 'text-error' },
};

export default function RecordingsView() {
  const recordings = useStore((s) => s.recordings);
  const removeRecording = useStore((s) => s.removeRecording);
  const stopRecording = useStore((s) => s.stopRecording);
  const loadRecordings = useStore((s) => s.loadRecordings);
  const [watching, setWatching] = useState(null);
  const [storage, setStorage] = useState(null);

  const hasActive = recordings.some((r) => r.status === 'recording');

  const loadStorage = () => api.storage().then(setStorage).catch(() => {});

  // Refresh on mount, then poll only while a capture is in progress (live size).
  useEffect(() => {
    loadRecordings();
    loadStorage();
  }, [loadRecordings]);
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => {
      loadRecordings();
      loadStorage();
    }, 4000);
    return () => clearInterval(id);
  }, [hasActive, loadRecordings]);

  const sorted = [...recordings].sort((a, b) => new Date(b.start) - new Date(a.start));

  const storageSegments = storage
    ? [
        `${formatBytes(storage.recordingsBytes)} used`,
        storage.diskFreeBytes != null ? `${formatBytes(storage.diskFreeBytes)} free` : null,
        storage.maxBytes ? `cap ${formatBytes(storage.maxBytes)}` : null,
      ].filter(Boolean)
    : [];

  return (
    <div className="md:ml-20 pt-24 md:pt-28 px-4 md:px-8 pb-8 min-h-screen">
      <div className="mb-6">
        <h1 className="text-2xl md:text-3xl font-semibold">Recordings</h1>
        <p className="text-on-surface-variant">{recordings.length} recordings</p>
        {storageSegments.length > 0 && (
          <p className="text-on-surface-variant text-sm">{storageSegments.join(' · ')}</p>
        )}
      </div>

      {sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-on-surface-variant gap-3 text-center">
          <Icon name="radio_button_checked" className="text-6xl opacity-60" />
          <p>No recordings yet.</p>
          <p className="text-sm">Use the Record button on a channel or the EPG guide to schedule one.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {sorted.map((rec) => {
            const st = STATUS[rec.status] || STATUS.completed;
            const isRecording = rec.status === 'recording';
            // Only finished captures have a complete, playable file.
            const hasFile =
              !!rec.filename && rec.size > 0 && (rec.status === 'completed' || rec.status === 'interrupted');
            return (
              <div key={rec.id} className="glass rounded-2xl p-4 flex gap-4">
                <ChannelLogo src={rec.channelLogo} kind="live" className="w-16 h-16" rounded="rounded-xl" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-[11px] uppercase flex items-center gap-1.5 ${st.color}`}>
                      <span className={`w-2 h-2 rounded-full bg-current ${st.pulse ? 'animate-pulse' : ''}`} />
                      {st.label}
                    </span>
                    {/* File size — the headline of this feature */}
                    <span className="font-mono text-[11px] text-on-surface-variant ml-auto">
                      {rec.status === 'scheduled' ? '—' : formatBytes(rec.size)}
                    </span>
                  </div>
                  <h3 className="font-semibold truncate mt-0.5">{rec.title}</h3>
                  <p className="text-on-surface-variant text-sm truncate">{rec.channelName}</p>
                  <p className="font-mono text-xs text-on-surface-variant mt-1">
                    {fmt(rec.start)} → {fmt(rec.end)}
                  </p>

                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                    {isRecording && (
                      <button
                        onClick={() => stopRecording(rec.id)}
                        className="text-sm text-red-400 hover:text-red-300 flex items-center gap-1"
                      >
                        <Icon name="stop_circle" fill className="text-lg" /> Stop
                      </button>
                    )}
                    {hasFile && (
                      <>
                        <button
                          onClick={() => setWatching(rec)}
                          className="text-sm text-primary hover:underline flex items-center gap-1"
                        >
                          <Icon name="play_arrow" className="text-lg" /> Watch
                        </button>
                        <a
                          href={recordingDownloadUrl(rec.id)}
                          download
                          className="text-sm text-primary hover:underline flex items-center gap-1"
                        >
                          <Icon name="download" className="text-lg" /> Download
                        </a>
                      </>
                    )}
                    {rec.status === 'failed' && (
                      <span className="text-xs text-error truncate" title={rec.error}>Capture failed</span>
                    )}
                    <button
                      onClick={() => removeRecording(rec.id)}
                      className="text-sm text-on-surface-variant hover:text-error flex items-center gap-1"
                    >
                      <Icon name="delete" className="text-lg" /> Remove
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Playback modal — plays the captured file (seekable, native controls) */}
      {watching && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setWatching(null)}
        >
          <div className="w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xl font-semibold truncate">{watching.title}</h2>
              <button onClick={() => setWatching(null)} className="text-on-surface-variant hover:text-on-surface" aria-label="Close">
                <Icon name="close" className="text-3xl" />
              </button>
            </div>
            <video
              src={recordingFileUrl(watching.id)}
              controls
              autoPlay
              className="w-full aspect-video rounded-2xl bg-black"
            />
          </div>
        </div>
      )}
    </div>
  );
}
