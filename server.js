// server.js
const express = require('express');
const app = express();
const http = require('http').createServer(app);

const io = require('socket.io')(http, {
  cors: {
    origin: '*', // 모든 도메인 허용 (필요하면 특정 도메인으로 변경)
    methods: ['GET', 'POST']
  }
});

const CANNON = require('cannon-es');

const PORT = process.env.PORT || 3000;

// 정적 파일 서비스
app.use(express.static('public'));

// 물리 월드 초기화
const world = new CANNON.World();
world.gravity.set(0, -9.82, 0);
world.broadphase = new CANNON.NaiveBroadphase();
world.solver.iterations = 10;

const players = {};
const bodies = {};

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  socket.on('joinGame', (data) => {
    console.log(`🚗 ${data.nickname} joined`);

    players[socket.id] = {
      nickname: data.nickname || 'Unknown',
      carModel: data.carModel || 'DefaultCar',
      carColor: data.carColor || '#ffffff',
      position: { x: 500, y: 0.5, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      input: {},
      gear: 'P'
    };

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

  socket.on('updatePosition', (data) => {
if (!players[socket.id]) return;

// 위치/회전 수신 → 서버 데이터 갱신
players[socket.id].position = data.position;
players[socket.id].rotation = data.rotation;
players[socket.id].input = data.input;
players[socket.id].gear = data.gear;
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
    if (bodies[socket.id]) {
      world.removeBody(bodies[socket.id]);
      delete bodies[socket.id];
    }
  });
});

// 물리 시뮬레이션 (60FPS)
setInterval(() => {
  const delta = 1 / 60;

  Object.keys(players).forEach((id) => {
    const player = players[id];
    const body = bodies[id];
    if (!body || !player.input) return;

    const force = new CANNON.Vec3();

    if (player.input.accel) force.z -= 1000;
    if (player.input.brake) force.z += 1000;
    if (player.input.left) body.angularVelocity.y += 0.05;
    if (player.input.right) body.angularVelocity.y -= 0.05;

    const q = body.quaternion;
    const f = q.vmult(force);
    body.applyForce(f, body.position);
  });

  world.step(delta);

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

  // 가볍게 정리해서 클라이언트로 전송
  const simplifiedPlayers = {};
  Object.keys(players).forEach((id) => {
    simplifiedPlayers[id] = {
      nickname: players[id].nickname,
      carModel: players[id].carModel,
      carColor: players[id].carColor,
      position: players[id].position,
      rotation: players[id].rotation,
      gear: players[id].gear
    };
  });

  io.emit('updatePlayers', simplifiedPlayers);
}, 1000 / 60);

// 서버 시작
http.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
