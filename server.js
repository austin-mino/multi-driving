 // server.js
const express = require('express');
const app = express();
const http = require('http').createServer(app);

const io = require('socket.io')(http, {
  cors: {
    origin: "*",  // 테스트용: 모든 도메인 허용
    methods: ["GET", "POST"]
  }
});

const CANNON = require('cannon-es');

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

const world = new CANNON.World();
world.gravity.set(0, -9.82, 0);
world.broadphase = new CANNON.NaiveBroadphase();
world.solver.iterations = 10;

let players = {};
let bodies = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

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

    // 자동차 물리 바디 생성 (박스 모양, 크기 적당히 조절 가능)
    const body = new CANNON.Body({
      mass: 1500, // 자동차 무게 (예시)
      shape: new CANNON.Box(new CANNON.Vec3(2, 1, 4)),
      position: new CANNON.Vec3(500, 0.5, 0),
      angularDamping: 0.5,  // 회전 감쇠
      linearDamping: 0.5,   // 속도 감쇠
    });

    world.addBody(body);
    bodies[socket.id] = body;

    socket.emit('playerId', socket.id);
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
    console.log('User disconnected:', socket.id);
    if (bodies[socket.id]) {
      world.removeBody(bodies[socket.id]);
      delete bodies[socket.id];
    }
    delete players[socket.id];
  });
});

// 물리 시뮬레이션 및 위치/회전 업데이트 주기 (60fps)
setInterval(() => {
  Object.keys(players).forEach((id) => {
    const player = players[id];
    const body = bodies[id];
    if (!body) return;

    // 예시: 엑셀 버튼 누르면 앞으로 힘 가하기 (z축 음수 방향)
    if (player.input.accel) {
      const force = new CANNON.Vec3(0, 0, -500);
      body.applyForce(force, body.position);
    }

    // 기어, 스티어링, 브레이크 등도 이곳에서 처리 가능

  });

  world.step(1 / 60);

  // 위치, 회전 데이터 갱신
  Object.keys(players).forEach((id) => {
    const body = bodies[id];
    if (body) {
      players[id].position = {
        x: body.position.x,
        y: body.position.y,
        z: body.position.z,
      };
      players[id].rotation = {
        x: body.quaternion.x,
        y: body.quaternion.y,
        z: body.quaternion.z,
        w: body.quaternion.w,
      };
    }
  });

  io.emit('updatePlayers', players);

}, 1000 / 60);

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
