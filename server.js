const express = require('express');
const app = express();
const http = require('http').createServer(app);

const io = require('socket.io')(http, {
  cors: {
    origin: '*', // 모든 도메인 허용
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3000;

// 정적 파일 서비스
app.use(express.static('public'));

const players = {};

// 클라이언트 접속 이벤트
io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  socket.on('joinGame', (data) => {
    try {
      console.log(`🚗 ${data.nickname} joined`);

      // 플레이어 초기 상태 등록 (물리 바디는 없음)
      players[socket.id] = {
        nickname: data.nickname || 'Unknown',
        carModel: data.carModel || 'DefaultCar',
        carColor: data.carColor || '#ffffff',
        position: { x: 500, y: 0.5, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        input: {},
        gear: 'P',
      };

      socket.emit('playerId', socket.id);
    } catch (e) {
      console.error('joinGame error:', e);
    }
  });

  // 클라이언트가 직접 계산한 위치/회전/기어/입력 받음
  socket.on('updatePosition', (data) => {
    if (!players[socket.id]) return;

    players[socket.id].position = data.position || players[socket.id].position;
    players[socket.id].rotation = data.rotation || players[socket.id].rotation;
    players[socket.id].input = data.input || players[socket.id].input;
    players[socket.id].gear = data.gear || players[socket.id].gear;
  });

  socket.on('updateInput', (input) => {
    if (players[socket.id]) {
      players[socket.id].input = input;
    }
  });

  socket.on('chatMessage', (msg) => {
    const nickname = players[socket.id]?.nickname || 'Unknown';
    io.emit('chatMessage', { sender: nickname, message: msg });
  });

  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
    delete players[socket.id];
  });
});

// 50ms 주기로 전체 플레이어 상태 브로드캐스트 (약 20FPS)
setInterval(() => {
  io.emit('updatePlayers', players);
}, 50);

http.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

function gracefulShutdown() {
  console.log('🛑 Server shutting down...');
  io.close(() => {
    console.log('Socket.io closed');
    process.exit(0);
  });
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
