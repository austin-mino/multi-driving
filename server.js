// npm install express socket.io
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

const PORT = process.env.PORT || 3000;

app.use(express.static('public')); // public 폴더에 위 html, js 등 파일 위치

let players = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 플레이어 입장
  socket.on('joinGame', (data) => {
    players[socket.id] = {
      nickname: data.nickname,
      carModel: data.carModel,
      carColor: data.carColor,
      position: {x:0,y:0,z:0},
      rotation: {x:0,y:0,z:0,w:1},
      input: {},
      gear: 'P',
    };
    socket.emit('playerId', socket.id);
  });

  // 플레이어 위치 업데이트
  socket.on('updatePosition', (data) => {
    if(players[socket.id]) {
      players[socket.id].position = {
        x: data.position.x,
        y: data.position.y,
        z: data.position.z,
      };
      players[socket.id].rotation = {
        x: data.rotation.x,
        y: data.rotation.y,
        z: data.rotation.z,
        w: data.rotation.w,
      };
      players[socket.id].input = data.input;
      players[socket.id].gear = data.gear;
    }
  });

  // 플레이어 접속 종료
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    delete players[socket.id];
  });

  // 일정 간격으로 전체 플레이어 상태 브로드캐스트
  setInterval(() => {
    io.emit('updatePlayers', players);
  }, 50);
});

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
