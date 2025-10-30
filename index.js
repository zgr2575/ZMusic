import express from "express";
import http from "node:http";
import { createBareServer } from "@tomphttp/bare-server-node";
import path from "node:path";
import cors from "cors";
import fetch from "node-fetch";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import dotenv from "dotenv";

dotenv.config();

const __dirname = process.cwd();
const server = http.createServer();
const app = express(server);
const bareServer = createBareServer("/o/");
const PORT = process.env.PORT || 8080;
const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
const downloadDirectory = path.join(process.cwd(), "downloads");

if (!clientId || !clientSecret || !redirectUri) {
  console.warn(
    "Spotify credentials or redirect URI are missing. Please set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REDIRECT_URI in your environment."
  );
}

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, "static")));
app.use("/downloads", express.static(downloadDirectory));

const sessions = new Map();
let clientCredentialsToken = null;
let clientCredentialsExpiry = 0;

const jobs = new Map();

const ensureDownloadDirectory = async () => {
  try {
    await fs.mkdir(downloadDirectory, { recursive: true });
  } catch (error) {
    console.error("Failed to create download directory", error);
  }
};

ensureDownloadDirectory();

const parseCookies = (req) => {
  const cookieHeader = req.headers?.cookie;
  if (!cookieHeader) {
    return {};
  }
  return cookieHeader.split(";").reduce((acc, part) => {
    const [key, ...rest] = part.trim().split("=");
    if (!key) {
      return acc;
    }
    acc[key] = decodeURIComponent(rest.join("="));
    return acc;
  }, {});
};

const setCookie = (res, name, value, options = {}) => {
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (options.maxAge) {
    cookie += `; Max-Age=${options.maxAge}`;
  }
  if (options.httpOnly) {
    cookie += "; HttpOnly";
  }
  if (options.secure) {
    cookie += "; Secure";
  }
  if (options.sameSite) {
    cookie += `; SameSite=${options.sameSite}`;
  }
  cookie += "; Path=/";
  res.append("Set-Cookie", cookie);
};

const getSession = (req, res, createIfMissing = true) => {
  const cookies = parseCookies(req);
  let sessionId = cookies.zmusic_session;
  if (sessionId && sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }
  if (!createIfMissing) {
    return null;
  }
  sessionId = crypto.randomUUID();
  const session = {
    id: sessionId,
    createdAt: Date.now(),
  };
  sessions.set(sessionId, session);
  setCookie(res, "zmusic_session", sessionId, {
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 30,
  });
  return session;
};

const ensureSpotifyToken = async (session) => {
  if (!session?.spotify) {
    throw new Error("Spotify account is not connected.");
  }

  const now = Date.now();
  if (session.spotify.expiresAt > now + 30_000) {
    return session.spotify.accessToken;
  }

  if (!session.spotify.refreshToken) {
    throw new Error("Spotify session has expired. Please sign in again.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: session.spotify.refreshToken,
  });

  const authOptions = {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  };

  const response = await fetch("https://accounts.spotify.com/api/token", authOptions);
  if (!response.ok) {
    throw new Error("Unable to refresh Spotify access token");
  }
  const data = await response.json();
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  session.spotify.accessToken = data.access_token;
  session.spotify.expiresAt = expiresAt;
  return data.access_token;
};

const getClientCredentials = async () => {
  const now = Date.now();
  if (clientCredentialsToken && clientCredentialsExpiry > now + 30_000) {
    return clientCredentialsToken;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
  });
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error("Unable to obtain Spotify client credentials token");
  }
  const data = await response.json();
  clientCredentialsToken = data.access_token;
  clientCredentialsExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return clientCredentialsToken;
};

const fetchSpotify = async (token, endpoint) => {
  const response = await fetch(`https://api.spotify.com/v1/${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (response.status === 204) {
    return null;
  }
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Spotify API error: ${error}`);
  }
  return response.json();
};

const parsePlaylistId = (input) => {
  if (!input) {
    return null;
  }
  const trimmed = input.trim();
  const spotifyUrlMatch = trimmed.match(/playlist\/(\w+)/);
  if (spotifyUrlMatch) {
    return spotifyUrlMatch[1];
  }
  const uriMatch = trimmed.match(/spotify:playlist:([\w]+)/);
  if (uriMatch) {
    return uriMatch[1];
  }
  if (/^[\w]+$/.test(trimmed)) {
    return trimmed;
  }
  return null;
};

const sanitizeFilename = (value) => {
  return value
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

const downloadTrackWithYtDlp = async (track) => {
  const safeTitle = sanitizeFilename(track.title || "Unknown Title");
  const artistString = sanitizeFilename((track.artists || []).join(", ") || "Unknown Artist");
  const filenameTemplate = `${safeTitle} - ${artistString}`.slice(0, 180);
  const outputTemplate = path.join(downloadDirectory, `${filenameTemplate}.%(ext)s`);
  const queryParts = [track.title, ...(track.artists || []), track.album].filter(Boolean);
  const ytQuery = `ytsearch1:${queryParts.join(" ")}`;

  return new Promise((resolve, reject) => {
    const args = [
      "-f",
      "bestaudio/best",
      "--extract-audio",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "--add-metadata",
      "--embed-thumbnail",
      "--no-progress",
      "--print",
      "after_move:filepath",
      "--output",
      outputTemplate,
      ytQuery,
    ];

    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`yt-dlp failed to start: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
        return;
      }
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const finalLine = lines.pop();
      if (!finalLine) {
        resolve(null);
        return;
      }
      const relative = path.relative(downloadDirectory, finalLine);
      resolve(relative.split(path.sep).join("/"));
    });
  });
};

const createDownloadJob = (tracks) => {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tracks: tracks.map((track, index) => ({
      id: track.id || `${id}-${index}`,
      title: track.title,
      artists: track.artists || [],
      album: track.album || null,
      cover: track.cover || null,
      durationMs: track.durationMs || null,
      status: "pending",
      error: null,
      fileUrl: null,
      order: index,
    })),
  };
  jobs.set(id, job);
  process.nextTick(() => runDownloadJob(job, tracks));
  return job;
};

const runDownloadJob = async (job, originalTracks) => {
  job.status = "running";
  job.updatedAt = Date.now();
  const updatedTracks = job.tracks;
  for (let i = 0; i < updatedTracks.length; i += 1) {
    const track = updatedTracks[i];
    track.status = "downloading";
    job.updatedAt = Date.now();
    try {
      const downloaded = await downloadTrackWithYtDlp(originalTracks[i]);
      if (downloaded) {
        track.status = "completed";
        track.fileUrl = `/downloads/${downloaded}`;
      } else {
        track.status = "missing";
        track.fileUrl = null;
      }
    } catch (error) {
      track.status = "failed";
      track.error = error.message;
    }
    job.updatedAt = Date.now();
  }
  job.status = updatedTracks.every((track) => track.status === "completed")
    ? "completed"
    : "completed_with_errors";
  job.updatedAt = Date.now();
};

const parseSyncedLyrics = (lyrics) => {
  if (!lyrics) {
    return [];
  }
  return lyrics
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/\[(\d+):(\d+)(?:\.(\d+))?](.*)/);
      if (!match) {
        return null;
      }
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const fraction = match[3] ? parseInt(match[3].padEnd(2, "0"), 10) : 0;
      const time = minutes * 60 + seconds + fraction / 100;
      const text = match[4].trim();
      if (!text) {
        return null;
      }
      return { time, text };
    })
    .filter(Boolean);
};

app.get("/api/session", (req, res) => {
  const session = getSession(req, res);
  res.json({
    sessionId: session.id,
    spotifyConnected: Boolean(session.spotify),
  });
});

app.get("/api/spotify/login", (req, res) => {
  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: "Spotify credentials are not configured" });
  }
  const session = getSession(req, res);
  const state = crypto.randomUUID();
  const scope = [
    "user-read-email",
    "playlist-read-private",
    "playlist-read-collaborative",
  ].join(" ");

  session.spotifyState = state;
  session.spotifyRedirect = req.query.redirect || "/app";

  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("state", state);

  res.redirect(authUrl.toString());
});

app.get("/api/spotify/me", async (req, res) => {
  try {
    const session = getSession(req, res, false);
    if (!session?.spotify) {
      return res.status(401).json({ error: "Spotify account not connected" });
    }
    const token = await ensureSpotifyToken(session);
    const profile = await fetchSpotify(token, "me");
    res.json(profile);
  } catch (error) {
    console.error("Failed to fetch Spotify profile", error);
    res.status(500).json({ error: "Failed to fetch Spotify profile" });
  }
});

app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).send(`Spotify authorization error: ${error}`);
  }
  if (!code) {
    return res.status(400).send("Authorization code is missing.");
  }
  const session = getSession(req, res, false);
  if (!session || !session.spotifyState || session.spotifyState !== state) {
    return res.status(400).send("Session mismatch. Please start the sign-in process again.");
  }
  const authOptions = {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }).toString(),
  };

  try {
    const response = await fetch("https://accounts.spotify.com/api/token", authOptions);
    const data = await response.json();

    if (!response.ok) {
      console.error("Failed to fetch access token", data);
      return res.status(400).send("Failed to fetch Spotify access token.");
    }

    session.spotify = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      scope: data.scope,
    };
    delete session.spotifyState;
    const redirectTarget = session.spotifyRedirect || "/app";
    delete session.spotifyRedirect;
    res.redirect(redirectTarget);
  } catch (callbackError) {
    console.error("Error fetching access token:", callbackError);
    res.status(500).send("Internal server error while completing Spotify authorization.");
  }
});

app.get("/api/playlists/spotify", async (req, res) => {
  try {
    const session = getSession(req, res, false);
    const playlistId = parsePlaylistId(req.query.input);
    if (!playlistId) {
      return res.status(400).json({ error: "A valid Spotify playlist URL or ID is required." });
    }
    let token = null;
    if (session?.spotify) {
      try {
        token = await ensureSpotifyToken(session);
      } catch (tokenError) {
        console.warn("Falling back to client credentials token", tokenError);
      }
    }
    if (!token) {
      token = await getClientCredentials();
    }

    const playlistResponse = await fetchSpotify(token, `playlists/${playlistId}`);
    const tracks = [...(playlistResponse?.tracks?.items || [])];
    let next = playlistResponse?.tracks?.next;
    while (next) {
      const nextResponse = await fetch(next, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!nextResponse.ok) {
        break;
      }
      const nextData = await nextResponse.json();
      tracks.push(...(nextData.items || []));
      next = nextData.next;
    }

    const normalizedTracks = tracks
      .map((item) => item.track)
      .filter((track) => track && track.type === "track")
      .map((track) => ({
        id: track.id || track.uri,
        title: track.name,
        artists: (track.artists || []).map((artist) => artist.name),
        album: track.album?.name,
        durationMs: track.duration_ms,
        cover: track.album?.images?.[0]?.url || null,
      }));

    res.json({
      id: playlistResponse.id,
      name: playlistResponse.name,
      description: playlistResponse.description,
      owner: playlistResponse.owner?.display_name,
      images: playlistResponse.images,
      tracks: normalizedTracks,
    });
  } catch (error) {
    console.error("Failed to load Spotify playlist", error);
    res.status(500).json({ error: "Failed to load Spotify playlist" });
  }
});

app.post("/api/downloads", (req, res) => {
  const { tracks } = req.body || {};
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return res.status(400).json({ error: "At least one track is required" });
  }
  const normalizedTracks = tracks.map((track) => ({
    id: track.id,
    title: track.title,
    artists: track.artists,
    album: track.album,
    cover: track.cover,
    durationMs: track.durationMs,
  }));
  const job = createDownloadJob(normalizedTracks);
  res.status(201).json(job);
});

app.get("/api/downloads/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Download job not found" });
  }
  res.json(job);
});

app.get("/api/lyrics", async (req, res) => {
  const { track, artist } = req.query;
  if (!track) {
    return res.status(400).json({ error: "Track name is required" });
  }
  try {
    const url = new URL("https://lrclib.net/api/get");
    url.searchParams.set("track_name", track);
    if (artist) {
      url.searchParams.set("artist_name", artist);
    }
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(404).json({ error: "Lyrics not found" });
    }
    const data = await response.json();
    res.json({
      synced: parseSyncedLyrics(data.syncedLyrics),
      plain: data.plainLyrics || null,
      source: data?.source || "lrclib",
    });
  } catch (error) {
    console.error("Failed to fetch lyrics", error);
    res.status(500).json({ error: "Failed to load lyrics" });
  }
});

const routes = [
  { path: "/", file: "index.html" },
  { path: "/app", file: "app.html" },
  { path: "/player", file: "player.html" },
];

routes.forEach((route) => {
  app.get(route.path, (req, res) => {
    res.sendFile(path.join(__dirname, "static", route.file));
  });
});

server.on("request", (req, res) => {
  if (bareServer.shouldRoute(req)) {
    bareServer.routeRequest(req, res);
  } else {
    app(req, res);
  }
});

server.on("upgrade", (req, socket, head) => {
  if (bareServer.shouldRoute(req)) {
    bareServer.routeUpgrade(req, socket, head);
  } else {
    socket.end();
  }
});

server.on("listening", () => {
  console.log(`Running at http://localhost:${PORT}`);
});

server.listen({ port: PORT });
