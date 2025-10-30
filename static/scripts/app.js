import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

const fetchJSON = async (url, options = {}) => {
  const merged = {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
    ...options,
  };

  const response = await fetch(url, merged);
  const text = await response.text();
  const hasBody = text.length > 0;
  let data = null;
  if (hasBody) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      console.warn("Failed to parse response as JSON", error);
    }
  }

  if (!response.ok) {
    const message = data?.error || response.statusText || "Request failed";
    throw new Error(message);
  }

  return data;
};

const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) {
    return "0:00";
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${mins}:${secs}`;
};

const statusLabel = {
  pending: "Waiting",
  downloading: "Downloading",
  completed: "Ready",
  missing: "Missing",
  failed: "Failed",
};

const statusIcon = {
  pending: "⏳",
  downloading: "🔄",
  completed: "✅",
  missing: "⚠️",
  failed: "❌",
};

const TrackRow = ({ track, isActive, onSelect }) => {
  const playable = Boolean(track.fileUrl);
  const className = [
    "queue-item",
    isActive ? "active" : "inactive",
    playable ? "" : "disabled",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      onClick={() => playable && onSelect(track.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" && playable) {
          onSelect(track.id);
        }
      }}
    >
      <img
        src={track.cover || "./images/defualt.png"}
        alt={track.title}
        loading="lazy"
      />
      <div>
        <div className="title">{track.title}</div>
        <div className="artists">{(track.artists || []).join(", ")}</div>
        <div className={`status ${track.status || "pending"}`}>
          <span aria-hidden="true">{statusIcon[track.status] || "♪"}</span>
          <span>{statusLabel[track.status] || "Pending"}</span>
        </div>
      </div>
    </div>
  );
};

const LyricsPanel = ({ lyrics, activeIndex }) => {
  if (!lyrics?.synced?.length) {
    return (
      <div className="lyrics-panel">
        <div className="lyrics-header">
          <strong>Lyrics</strong>
          <span>No synced lyrics available</span>
        </div>
        <div className="no-lyrics">
          Try another track or add lyrics metadata to the file.
        </div>
      </div>
    );
  }

  return (
    <div className="lyrics-panel">
      <div className="lyrics-header">
        <strong>Lyrics</strong>
        <span>Auto-synced via LRCLIB</span>
      </div>
      <div className="lyrics-lines">
        {lyrics.synced.map((line, index) => (
          <div
            key={`${line.time}-${line.text}`}
            className={`lyric-line ${index === activeIndex ? "active" : ""}`}
          >
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
};

const App = () => {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [playlistInput, setPlaylistInput] = useState("");
  const [playlist, setPlaylist] = useState(null);
  const [job, setJob] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState(null);
  const [activeTrackId, setActiveTrackId] = useState(null);
  const [lyrics, setLyrics] = useState({ synced: [], plain: null });
  const [lyricIndex, setLyricIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);

  const audioRef = useRef(null);

  useEffect(() => {
    fetchJSON("/api/session")
      .then((sessionData) => setSession(sessionData))
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!session?.spotifyConnected) {
      setProfile(null);
      return;
    }
    fetchJSON("/api/spotify/me")
      .then((data) => setProfile(data))
      .catch(() => setProfile(null));
  }, [session]);

  useEffect(() => {
    if (!jobId) {
      return undefined;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const data = await fetchJSON(`/api/downloads/${jobId}`);
        if (!cancelled) {
          setJob(data);
          if (
            data.status === "completed" ||
            data.status === "completed_with_errors"
          ) {
            return;
          }
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to poll download status", err);
        }
      }
      if (!cancelled) {
        setTimeout(poll, 3000);
      }
    };

    poll();

    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    if (!job || activeTrackId) {
      return;
    }
    const firstCompleted = job.tracks?.find((track) => track.fileUrl);
    if (firstCompleted) {
      setActiveTrackId(firstCompleted.id);
    }
  }, [job, activeTrackId]);

  const activeTrack = useMemo(() => {
    if (!job?.tracks) {
      return null;
    }
    return job.tracks.find((track) => track.id === activeTrackId) || null;
  }, [job, activeTrackId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (!activeTrack?.fileUrl) {
      audio.pause();
      setIsPlaying(false);
      return;
    }

    const newSrc = new URL(activeTrack.fileUrl, window.location.origin).toString();
    if (audio.src !== newSrc) {
      audio.src = newSrc;
      audio.load();
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);
      const autoPlay = async () => {
        try {
          await audio.play();
        } catch (err) {
          console.warn("Playback prevented", err);
        }
      };
      autoPlay();
    }
  }, [activeTrack]);

  useEffect(() => {
    if (!activeTrack) {
      setLyrics({ synced: [], plain: null });
      setLyricIndex(-1);
      return;
    }

    let cancelled = false;
    const loadLyrics = async () => {
      try {
        const params = new URLSearchParams();
        params.set("track", activeTrack.title || "");
        if (activeTrack.artists?.length) {
          params.set("artist", activeTrack.artists[0]);
        }
        const data = await fetchJSON(`/api/lyrics?${params.toString()}`);
        if (!cancelled) {
          setLyrics({
            synced: data?.synced || [],
            plain: data?.plain || null,
          });
          setLyricIndex(data?.synced?.length ? 0 : -1);
        }
      } catch (err) {
        if (!cancelled) {
          setLyrics({ synced: [], plain: null });
          setLyricIndex(-1);
        }
      }
    };
    loadLyrics();

    return () => {
      cancelled = true;
    };
  }, [activeTrack?.id]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !lyrics.synced?.length) {
      return undefined;
    }
    const handleTimeUpdate = () => {
      const position = audio.currentTime;
      let index = lyrics.synced.length - 1;
      for (let i = 0; i < lyrics.synced.length; i += 1) {
        const line = lyrics.synced[i];
        const next = lyrics.synced[i + 1];
        if (position >= line.time && (!next || position < next.time)) {
          index = i;
          break;
        }
      }
      setLyricIndex(index);
    };
    audio.addEventListener("timeupdate", handleTimeUpdate);
    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
    };
  }, [lyrics]);

  const playableTracks = useMemo(() => {
    if (!job?.tracks) {
      return [];
    }
    return job.tracks.filter((track) => track.fileUrl);
  }, [job]);

  const goToNextTrack = useCallback(() => {
    if (!playableTracks.length || !activeTrackId) {
      return;
    }
    const index = playableTracks.findIndex((track) => track.id === activeTrackId);
    if (index >= 0 && index < playableTracks.length - 1) {
      setActiveTrackId(playableTracks[index + 1].id);
    }
  }, [playableTracks, activeTrackId]);

  const goToPreviousTrack = useCallback(() => {
    if (!playableTracks.length || !activeTrackId) {
      return;
    }
    const index = playableTracks.findIndex((track) => track.id === activeTrackId);
    if (index > 0) {
      setActiveTrackId(playableTracks[index - 1].id);
    }
  }, [playableTracks, activeTrackId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return undefined;
    }

    const handleLoaded = () => {
      setDuration(audio.duration || 0);
    };
    const handleTime = () => {
      if (!isSeeking) {
        setCurrentTime(audio.currentTime || 0);
      }
    };
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => {
      setIsPlaying(false);
      goToNextTrack();
    };

    audio.addEventListener("loadedmetadata", handleLoaded);
    audio.addEventListener("timeupdate", handleTime);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("loadedmetadata", handleLoaded);
      audio.removeEventListener("timeupdate", handleTime);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [isSeeking, goToNextTrack]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !activeTrack?.fileUrl) {
      return;
    }
    if (audio.paused) {
      audio
        .play()
        .then(() => setIsPlaying(true))
        .catch((err) => console.warn("Failed to play", err));
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  }, [activeTrack]);

  const handleSeek = useCallback((value) => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const newPosition = Number(value);
    audio.currentTime = newPosition;
    setCurrentTime(newPosition);
  }, []);

  const importPlaylist = async (event) => {
    event.preventDefault();
    if (!playlistInput.trim()) {
      setError("Paste a Spotify playlist link to begin.");
      return;
    }
    setIsImporting(true);
    setError(null);
    try {
      const playlistData = await fetchJSON(
        `/api/playlists/spotify?input=${encodeURIComponent(playlistInput.trim())}`
      );
      setPlaylist(playlistData);
      const jobData = await fetchJSON("/api/downloads", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tracks: playlistData.tracks }),
      });
      setJob(jobData);
      setJobId(jobData.id);
      setActiveTrackId(null);
    } catch (err) {
      setError(err.message || "Unable to import playlist.");
    } finally {
      setIsImporting(false);
    }
  };

  const handleLogin = () => {
    window.location.href = "/api/spotify/login?redirect=/app";
  };

  const downloadProgress = useMemo(() => {
    if (!job?.tracks?.length) {
      return 0;
    }
    const completed = job.tracks.filter((track) => track.status === "completed").length;
    return Math.round((completed / job.tracks.length) * 100);
  }, [job]);

  const statusMessage = useMemo(() => {
    if (!job) {
      return "Waiting";
    }
    if (job.status === "running") {
      return "Downloading with yt-dlp";
    }
    if (job.status === "completed") {
      return "Ready to play";
    }
    if (job.status === "completed_with_errors") {
      return "Finished with some issues";
    }
    return job.status;
  }, [job]);

  const displayedTracks = useMemo(() => {
    if (job?.tracks?.length) {
      return job.tracks;
    }
    if (playlist?.tracks?.length) {
      return playlist.tracks.map((track) => ({
        ...track,
        status: "pending",
      }));
    }
    return [];
  }, [job, playlist]);

  return (
    <div className="app-shell">
      <aside className="sidebar glass">
        <div>
          <h1>ZMusic</h1>
          <div className="tagline">Download high fidelity playlists in minutes.</div>
        </div>

        <div className="session-card">
          <strong>Spotify</strong>
          {profile ? (
            <div className="profile">
              <img
                src={profile.images?.[0]?.url || "./images/defualt.png"}
                alt={profile.display_name || "Spotify profile"}
              />
              <div>
                <div>{profile.display_name || "Connected"}</div>
                <div className="badge connected">Connected</div>
              </div>
            </div>
          ) : (
            <div>
              <p className="tagline">
                Sign in to access private playlists or collaborate with Spotify.
              </p>
              <button
                className="button-secondary"
                onClick={handleLogin}
                type="button"
              >
                Sign in with Spotify
              </button>
            </div>
          )}
        </div>

        <form className="import-card" onSubmit={importPlaylist}>
          <strong>Import playlist</strong>
          <input
            type="text"
            value={playlistInput}
            placeholder="https://open.spotify.com/playlist/..."
            onChange={(event) => setPlaylistInput(event.target.value)}
            aria-label="Spotify playlist link"
          />
          <button
            className={`button-primary ${isImporting ? "button-disabled" : ""}`}
            type="submit"
            disabled={isImporting}
          >
            {isImporting ? "Fetching..." : "Download with yt-dlp"}
          </button>
        </form>

        {error && <div className="error-banner">{error}</div>}

        <div className="status-card">
          <strong>Download status</strong>
          <div className="progress-track">
            <div className="progress-bar" style={{ width: `${downloadProgress}%` }} />
          </div>
          <div className="meta">
            <span>{statusMessage}</span>
            <span>{downloadProgress}%</span>
          </div>
        </div>

        <div className="app-footer">
          Audio is fetched in the best quality available via yt-dlp search.
          Lyrics are powered by LRCLIB.
        </div>
      </aside>

      <main className="main-panel">
        <section className="now-playing">
          <div className="album-art">
            <img
              src={
                activeTrack?.cover ||
                playlist?.images?.[0]?.url ||
                "./images/defualt.png"
              }
              alt={activeTrack?.title || "Album artwork"}
            />
          </div>
          <div className="track-summary">
            <h2>{activeTrack?.title || "Waiting for downloads"}</h2>
            <div className="artists">
              {(activeTrack?.artists || playlist?.owner || "Paste a playlist to begin")
                .toString()
                .replace(/,/g, ", ")}
            </div>

            <div className="controls">
              <button
                className={`control-button ${
                  playableTracks.length > 0 ? "" : "disabled"
                }`}
                type="button"
                onClick={goToPreviousTrack}
                disabled={!playableTracks.length}
                aria-label="Previous track"
              >
                ◀
              </button>
              <button
                className={`control-button primary ${
                  activeTrack?.fileUrl ? "" : "disabled"
                }`}
                type="button"
                onClick={togglePlayback}
                disabled={!activeTrack?.fileUrl}
                aria-label={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? "❚❚" : "▶"}
              </button>
              <button
                className={`control-button ${
                  playableTracks.length > 0 ? "" : "disabled"
                }`}
                type="button"
                onClick={goToNextTrack}
                disabled={!playableTracks.length}
                aria-label="Next track"
              >
                ▶
              </button>
            </div>

            <div className="timeline">
              <div className="time-row">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
              <input
                type="range"
                min="0"
                max={Math.max(duration, 0.1)}
                step="0.1"
                value={Math.min(currentTime, duration || 0)}
                onChange={(event) => handleSeek(event.target.value)}
                onMouseDown={() => setIsSeeking(true)}
                onMouseUp={() => setIsSeeking(false)}
                onTouchStart={() => setIsSeeking(true)}
                onTouchEnd={() => setIsSeeking(false)}
                disabled={!activeTrack?.fileUrl}
              />
            </div>
          </div>
        </section>

        <LyricsPanel lyrics={lyrics} activeIndex={lyricIndex} />

        <audio ref={audioRef} preload="metadata" hidden />
      </main>

      <aside className="queue-panel glass">
        <h3>Queue</h3>
        <div className="queue-list">
          {displayedTracks.length === 0 ? (
            <div className="no-lyrics">
              Once you import a playlist, tracks appear here with live status
              updates.
            </div>
          ) : (
            displayedTracks.map((track) => (
              <TrackRow
                key={track.id}
                track={track}
                isActive={track.id === activeTrackId}
                onSelect={setActiveTrackId}
              />
            ))
          )}
        </div>
      </aside>
    </div>
  );
};

const container = document.getElementById("root");
const root = createRoot(container);
root.render(<App />);
