// server.js
const express = require('express');
const app = express();
const http = require('http').createServer(app);

// CORS 포함 socket.io 초기화
const io = require('socket.io')(http, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const CANNON = require('cannon-es');

const PORT = process.env.PORT || 3000;

// 정적 파일 서비스
app.use(express.static('public'));

// 물리 월드 초기화
const world = new CANNON.World();
world.gravity.set(0, -9.82, 0); // 지구 중력
world.broadphase = new CANNON.NaiveBroadphase();
world.solver.iterations = 10;

const players = {};
const bodies = {};

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  // 게임 참가
  socket.on('joinGame', (data) => {
    console.log(`🚗 ${data.nickname} joined`);

    // 플레이어 정보 저장
    players[socket.id] = {
      nickname: data.nickname || 'Unknown',
      carModel: data.carModel || 'DefaultCar',
      carColor: data.carColor || '#ffffff',
      position: { x: 500, y: 0.5, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      input: {},
      gear: 'P'
    };

    // 자동차 바디 생성
    const body = new CANNON.Body({
      mass: 1500,
      shape: new CANNON.Box(new CANNON.Vec3(2, 1, 4)),
      position: new CANNON.Vec3(500, 0.5, 0),
      linearDamping: 0.5,
      angularDamping: 0.5
    });

    world.addBody(body);
    bodies[socket.id] = body;

    socket.emit('playerId', socket.id);
  });

  // 입력 업데이트
  socket.on('updateInput', (input) => {
    if (players[socket.id]) {
      players[socket.id].input = input;
    }
  });

  // 채팅
  socket.on('chatMessage', (msg) => {
    const nickname = players[socket.id]?.nickname || 'Unknown';
    io.emit('chatMessage', { sender: nickname, message: msg });
  });

  // 연결 종료
  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
    delete players[socket.id];
    if (bodies[socket.id]) {
      world.removeBody(bodies[socket.id]);
      delete bodies[socket.id];
    }
  });
});

// 물리 시뮬레이션 (60FPS)
setInterval(() => {
  const delta = 1 / 60;

  // 입력에 따라 바디에 힘 적용
  Object.keys(players).forEach((id) => {
    const player = players[id];
    const body = bodies[id];
    if (!body || !player.input) return;

    const force = new CANNON.Vec3();

    if (player.input.accel) {
      force.z -= 1000;
    }
    if (player.input.brake) {
      force.z += 1000;
    }
    if (player.input.left) {
      body.angularVelocity.y += 0.05;
    }
    if (player.input.right) {
      body.angularVelocity.y -= 0.05;
    }

    // 자동차 방향에 따라 로컬 Z축 기준으로 힘 적용
    const q = body.quaternion;
    const f = q.vmult(force);
    body.applyForce(f, body.position);
  });

  world.step(delta);

  // 모든 플레이어 위치/회전 업데이트
  Object.keys(players).forEach((id) => {
    const body = bodies[id];
    if (body) {
      players[id].position = {
        x: body.position.x,
        y: body.position.y,
        z: body.position.z
      };
      players[id].rotation = {
        x: body.quaternion.x,
        y: body.quaternion.y,
        z: body.quaternion.z,
        w: body.quaternion.w
      };
    }
  });

  io.emit('updatePlayers', players);
}, 1000 / 60);

// 서버 시작
http.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
