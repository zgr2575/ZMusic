  import express from "express";
  import basicAuth from "express-basic-auth";
  import http from "node:http";
  import { createBareServer } from "@tomphttp/bare-server-node";
  import path from "node:path";
  import cors from "cors";
  const __dirname = process.cwd();
  const server = http.createServer();
  const app = express(server);
  const bareServer = createBareServer("/o/");
  import fetch from "node-fetch";
  const PORT = process.env.PORT || 8080;
  var v = 1;
  console.log("Current Version of SBE: " + v);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cors());
  app.use(express.static(path.join(__dirname, "static")));

  
    const routes = [
      { path: "/", file: "index.html" },
       { path: "/!", file: "backinfo.html" },
    ];

    routes.forEach((route) => {
      app.get(route.path, (req, res) => {
        res.sendFile(path.join(__dirname, "static", route.file));
      });
    });
  

  const fetchData = async (req, res, next, baseUrl) => {
    try {
      const reqTarget = `${baseUrl}/${req.params[0]}`;
      const asset = await fetch(reqTarget);

      if (asset.ok) {
        const data = await asset.arrayBuffer();
        res.end(Buffer.from(data));
      } else {
        next();
      }
    } catch (error) {
      console.error("Error fetching:", error);
      next(error);
    }
  };
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

  server.listen({
    port: PORT,
  });
