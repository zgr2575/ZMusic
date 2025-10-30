# ZMusic

ZMusic is a desktop-inspired music experience that lets you import public or
private Spotify playlists, download the audio in the highest quality available
with `yt-dlp`, and enjoy synced lyrics inside a polished player UI.

## Features

* **Spotify integration** – sign in with your Spotify account to unlock private
  playlists or simply paste any public playlist link.
* **Lossless-first downloads** – every track is fetched with `yt-dlp` using the
  best audio profile that YouTube exposes, embedded metadata, and artwork.
* **Apple Music style lyrics** – ZMusic pulls time-coded lyrics from LRCLIB and
  animates them word-for-word as the song plays.
* **Job tracking** – keep an eye on download progress, failure states, and
  ready-to-play files from a single queue.

## Getting started

1. Install dependencies and make sure `yt-dlp` is available in your `$PATH`.
2. Configure Spotify credentials by adding the following to a `.env` file:

   ```env
   SPOTIFY_CLIENT_ID=your_client_id
   SPOTIFY_CLIENT_SECRET=your_client_secret
   SPOTIFY_REDIRECT_URI=https://your-domain/callback
   ```

   The redirect URI must be registered in your Spotify developer dashboard and
   should point back to the `/callback` route served by this application.
3. Start the server with `npm start`.
4. Visit `/app` to launch the experience, sign in with Spotify if you need
   access to private playlists, paste a playlist link, and let ZMusic handle the
   rest.

All downloaded audio files are stored in the `downloads/` directory and exposed
under the `/downloads` route so the player can stream them immediately.