import express from 'express';
import http from 'http';
import { Server } from 'socket.io';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let players = {};

app.use(express.static('public'));

io.on('connection', socket => {
  console.log('접속:', socket.id);

  socket.on('join', data => {
    players[socket.id] = { 
      ...data, position: [0,0,0], quaternion: [0,0,0,1]
    };
    io.emit('players', players);
  });

  socket.on('update', dt => {
    if (players[socket.id]) {
      players[socket.id].position = dt.position;
      players[socket.id].quaternion = dt.quaternion;
    }
    io.emit('players', players);
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('players', players);
  });
});

server.listen(3000, () => console.log('서버 3000번에서 실행 중'));
