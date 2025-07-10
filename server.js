// server.js
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

const PORT = process.env.PORT || 3000;

// 정적 파일 서비스 (public 폴더에 클라이언트 HTML, JS 파일 등 위치)
app.use(express.static('public'));

let players = {}; // 접속 중인 모든 플레이어 상태 저장

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 플레이어 입장 처리
  socket.on('joinGame', (data) => {
    players[socket.id] = {
      nickname: data.nickname || 'Unknown',
      carModel: data.carModel || 'DefaultCar',
      carColor: data.carColor || '#ffffff',
      position: { x: 500, y: 0.5, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      input: {},
      gear: 'P',
    };
    // 플레이어에게 자신의 ID 전달
    socket.emit('playerId', socket.id);
  });

  // 플레이어 위치 및 상태 업데이트
  socket.on('updatePosition', (data) => {
    if (players[socket.id]) {
      players[socket.id].position = data.position;
      players[socket.id].rotation = data.rotation;
      players[socket.id].input = data.input;
      players[socket.id].gear = data.gear;
    }
  });

  // 플레이어 접속 종료 처리
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    delete players[socket.id];
  });
});

// 모든 클라이언트에 플레이어 상태를 주기적으로 방송 (20fps)
setInterval(() => {
  io.emit('updatePlayers', players);
}, 50);

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
