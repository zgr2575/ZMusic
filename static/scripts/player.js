const clientId = '20e51623dd514e869ffb03b173a9e77c';
const redirectUri = 'https://zm3s806k-8080.use.devtunnels.ms/player';
let accessToken;

const authorize = () => {
  const authUrl = `https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user-modify-playback-state%20user-read-playback-state`;
  window.location = authUrl;
};

const getAccessToken = () => {
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  accessToken = params.get('access_token');
};

const apiRequest = (endpoint, method = 'GET', body = null) => {
  return fetch(`https://api.spotify.com/v1/${endpoint}`, {
    method: method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : null,
  });
};

document.getElementById('play-pause-btn').addEventListener('click', () => {
  apiRequest('me/player/play', 'PUT').catch(err => console.error(err));
});

document.getElementById('next-btn').addEventListener('click', () => {
  apiRequest('me/player/next', 'POST').catch(err => console.error(err));
});

document.getElementById('prev-btn').addEventListener('click', () => {
  apiRequest('me/player/previous', 'POST').catch(err => console.error(err));
});

document.getElementById('shuffle-btn').addEventListener('click', () => {
  apiRequest('me/player/shuffle?state=true', 'PUT').catch(err => console.error(err));
});

document.getElementById('restart-btn').addEventListener('click', () => {
  apiRequest('me/player/seek?position_ms=0', 'PUT').catch(err => console.error(err));
});

document.addEventListener('DOMContentLoaded', () => {
  if (!accessToken) {
    getAccessToken();
    if (!accessToken) {
      authorize();
    }
  }
});
