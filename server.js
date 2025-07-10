// server.js
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let players = {};

io.on('connection', socket => {
  console.log('Connected:', socket.id);

  socket.on('join', data => {
    players[socket.id] = {
      nickname: data.nickname,
      carType: data.carType,
      color: data.color,
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
    };
    io.emit('players', players);
  });

  socket.on('update', data => {
    if (players[socket.id]) {
      players[socket.id].position = data.position;
      players[socket.id].quaternion = data.quaternion;
    }
    io.emit('players', players);
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('players', players);
  });
});

server.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});
