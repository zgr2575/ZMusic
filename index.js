import express from "express";
import http from "node:http";
import { createBareServer } from "@tomphttp/bare-server-node";
import path from "node:path";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const __dirname = process.cwd();
const server = http.createServer();
const app = express(server);
const bareServer = createBareServer("/o/");
const PORT = process.env.PORT || 8080;
const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const redirectUri = 'https://zm3s806k-8080.use.devtunnels.ms/callback'; // Ensure this matches the registered URI

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, "static")));

const routes = [
  { path: "/", file: "index.html" },
  { path: "/player", file: "player.html" },
];

routes.forEach((route) => {
  app.get(route.path, (req, res) => {
    res.sendFile(path.join(__dirname, "static", route.file));
  });
});

app.get('/callback', async (req, res) => {
  const code = req.query.code || null;

  if (!code) {
    return res.status(400).send('Authorization code is missing.');
  }

  const authOptions = {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
    }).toString(),
  };

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', authOptions);
    const data = await response.json();

    if (response.ok) {
      const { access_token } = data;
      res.redirect(`/player?access_token=${access_token}`);
    } else {
      res.status(400).json({ error: 'Failed to fetch access token' });
    }
  } catch (error) {
    console.error('Error fetching access token:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
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
