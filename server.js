 /**
 * server.js
 * 
 * Node.js + Express + Socket.io 기반 서버
 * 클라이언트가 직접 물리 연산을 하고,
 * 서버는 각 클라이언트의 위치, 회전, 상태를 받아
 * 모든 플레이어에게 동기화 정보를 50ms마다 중계하는 구조
 * 
 * 이 서버는 물리 엔진(CANNON 등)을 사용하지 않고,
 * 단순히 상태 중계만 담당
 */

const express = require('express');
const app = express();

// http 서버 생성 - express 앱을 래핑
const http = require('http').createServer(app);

// socket.io 인스턴스 생성 및 CORS 설정 (모든 도메인 허용)
const io = require('socket.io')(http, {
  cors: {
    origin: '*', // 개발용. 배포 시에는 제한하는 게 좋음
    methods: ['GET', 'POST'],
  },
});

// 서버가 사용할 포트 설정 (환경변수 PORT가 없으면 3000번)
const PORT = process.env.PORT || 3000;

// 정적 파일 제공: 클라이언트용 html, js, css 파일은 /public 폴더에 넣고 서비스
app.use(express.static('public'));

// 접속한 플레이어 상태 저장 객체
// 키: socket.id, 값: 플레이어 상태 객체
const players = {};

/**
 * 소켓 연결 이벤트 처리
 * 클라이언트가 접속하면 socket 객체가 생성됨
 */
io.on('connection', (socket) => {
  console.log(`🔌 유저 접속: ${socket.id}`);

  /**
   * 클라이언트가 게임 참가 시 보내는 이벤트
   * 데이터 예: { nickname: '플레이어이름', carModel: '모델명', carColor: '#ffffff' }
   */
  socket.on('joinGame', (data) => {
    try {
      console.log(`🚗 플레이어 참가: ${data.nickname || 'Unknown'}`);

      // 서버에 플레이어 초기 상태 등록
      players[socket.id] = {
        nickname: data.nickname || 'Unknown',
        carModel: data.carModel || 'DefaultCar',
        carColor: data.carColor || '#ffffff',
        // 초기 위치 (예: 게임 시작 지점)
        position: { x: 0, y: 0, z: 0 },
        // 초기 회전 (쿼터니언)
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        // 입력 상태 (예: 가속, 감속, 좌우)
        input: {},
        // 기어 상태 (예: P, D, R)
        gear: 'P',
      };

      // 클라이언트에게 자신의 소켓 ID 전달 (클라 내부 식별용)
      socket.emit('playerId', socket.id);

      // 모든 플레이어에게 최신 플레이어 목록 중계 (옵션)
      io.emit('updatePlayers', players);
    } catch (e) {
      console.error('joinGame 처리 중 오류:', e);
    }
  });

  /**
   * 클라이언트가 주기적으로 보내는 위치/회전/기어/입력 상태 업데이트 이벤트
   * data 예시:
   * {
   *   position: { x: 1.23, y: 0, z: -5.67 },
   *   rotation: { x: 0, y: 0, z: 0, w: 1 },
   *   gear: 'D',
   *   input: { accel: true, brake: false, left: false, right: true }
   * }
   */
  socket.on('updatePosition', (data) => {
  if (!players[socket.id]) {
    // 플레이어가 등록 안 됐으면 무시
    return;
  }

  if (
    data.position &&
    typeof data.position.x === 'number' &&
    typeof data.position.y === 'number' &&
    typeof data.position.z === 'number'
  ) {
    players[socket.id].position = data.position;
  }

  if (
    data.rotation &&
    typeof data.rotation.x === 'number' &&
    typeof data.rotation.y === 'number' &&
    typeof data.rotation.z === 'number' &&
    typeof data.rotation.w === 'number'
  ) {
    players[socket.id].rotation = data.rotation;
  }

  if (typeof data.gear === 'string') {
    players[socket.id].gear = data.gear;
  }
});


  /**
   * 클라이언트가 별도로 입력 상태만 보낼 수도 있음 (선택 사항)
   */
  socket.on('updateInput', (input) => {
    if (players[socket.id]) {
      players[socket.id].input = input;
    }
  });

  /**
   * 채팅 메시지 이벤트 처리 (선택)
   */
  socket.on('chatMessage', (msg) => {
    const nickname = players[socket.id]?.nickname || 'Unknown';
    io.emit('chatMessage', { sender: nickname, message: msg });
  });

  /**
   * 클라이언트 접속 종료 시 처리
   */
  socket.on('disconnect', () => {
    console.log(`❌ 유저 접속 종료: ${socket.id}`);

    // 플레이어 상태 삭제
    delete players[socket.id];

    // 모든 플레이어에게 최신 상태 중계 (옵션)
    io.emit('updatePlayers', players);
  });
});

/**
 * 서버가 모든 플레이어 상태를 주기적으로 중계하는 부분
 * 50ms마다 (약 20FPS) 모든 플레이어 위치/회전 정보를 브로드캐스트
 */
setInterval(() => {
  io.emit('updatePlayers', players);
}, 50);

/**
 * 서버 시작
 * '0.0.0.0' 바인딩은 외부 접속 허용용 (서버 실행 환경에 따라 선택적)
 */
http.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 서버 가동 중 - 포트 ${PORT}`);
});

/**
 * 서버 종료 시 소켓 종료 처리 (옵션)
 */
function gracefulShutdown() {
  console.log('🛑 서버 종료 중...');
  io.close(() => {
    console.log('소켓 닫힘');
    process.exit(0);
  });
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
