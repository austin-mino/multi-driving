// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

// 정적 파일 서비스 (index.html, js, css 등)
app.use(express.static('public'));

// 접속한 플레이어들 관리 (id -> 플레이어 정보)
const players = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // 새 플레이어 접속
  socket.on('newPlayer', (data) => {
    console.log(`New player joined: ${data.nickname} (${socket.id})`);
    players.set(socket.id, {
      id: socket.id,
      nickname: data.nickname,
      carType: data.carType,
      carColor: data.carColor,
      position: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
    });

    // 접속한 새 플레이어에게 기존 플레이어 정보 모두 보내기
    for (const [id, player] of players) {
      if (id !== socket.id) {
        socket.emit('newPlayer', player);
      }
    }

    // 다른 플레이어들에게 새 플레이어 정보 전송
    socket.broadcast.emit('newPlayer', players.get(socket.id));
  });

  // 플레이어 위치 및 회전 업데이트
  socket.on('playerUpdate', (data) => {
    if (players.has(socket.id)) {
      const player = players.get(socket.id);
      player.position = data.position;
      player.quaternion = data.quaternion;

      // 다른 플레이어들에게 업데이트 전송
      socket.broadcast.emit('playerUpdate', {
        id: socket.id,
        position: data.position,
        quaternion: data.quaternion,
      });
    }
  });

  // 플레이어 퇴장 처리
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    players.delete(socket.id);
    io.emit('playerDisconnect', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
