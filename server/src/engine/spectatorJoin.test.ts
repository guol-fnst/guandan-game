import assert from 'node:assert/strict';
import test from 'node:test';
import { setupSocketHandlers } from '../handlers/socketHandlers';
import { RoomManager } from '../services/RoomManager';
import { GameRoom } from '../services/GameRoom';

class TestSocket {
  id = 'test-connection';
  currentRoomId?: string;
  username = 'Viewer';
  handlers = new Map<string, (data?: any) => void>();
  events: Array<{ event: string; data: any }> = [];
  constructor(public userId: string) {}
  on(event: string, callback: (data?: any) => void) { this.handlers.set(event, callback); }
  emit(event: string, data: any) { this.events.push({ event, data }); }
  join(_room: string) {}
  leave(_room: string) {}
  send(event: string, data?: any) { this.handlers.get(event)!(data); }
}

test('password-protected spectator entry can request the snapshot again after navigation', t => {
  let room!: GameRoom;
  const create = RoomManager.prototype.createRoom;
  t.mock.method(RoomManager.prototype, 'createRoom', function (this: RoomManager, ...args: Parameters<typeof create>) {
    room = create.apply(this, args);
    return room;
  });
  let connect!: (socket: any) => void;
  const io = { on(_event: string, cb: typeof connect) { connect = cb; }, emit() {}, to() { return { emit() {} }; } };
  setupSocketHandlers(io as any);
  const host = new TestSocket('host');
  connect(host);
  host.send('create_room', { name: 'Spectator regression', password: 'room-secret', aiUseLLM: false });
  for (let i = 0; i < 4; i++) room.addPlayer(`p${i}`, `P${i}`, 2, new TestSocket(`p${i}`));
  room.startGame();
  try {
    const viewer = new TestSocket('viewer');
    connect(viewer);
    viewer.send('join_spectator', { roomId: room.id, password: 'room-secret' });
    assert.ok(viewer.events.some(item => item.event === 'spectator_joined'));
    viewer.events = [];
    // GameRoom mounts after Lobby and requests a fresh snapshot without a password.
    viewer.send('join_spectator', { roomId: room.id });
    assert.ok(!viewer.events.some(item => item.event === 'error'));
    assert.ok(viewer.events.some(item => item.event === 'game_state'));
    assert.ok(viewer.events.some(item => item.event === 'spectator_hands' && Object.keys(item.data).length === 4));
    assert.equal(room.toRoomInfo().spectatorCount, 1);

    const stranger = new TestSocket('stranger');
    connect(stranger);
    stranger.send('join_spectator', { roomId: room.id });
    assert.ok(stranger.events.some(item => item.event === 'error' && item.data.message === '房间密码错误'));
    assert.ok(!stranger.events.some(item => item.event === 'game_state' || item.event === 'spectator_hands'));
  } finally { room.clearPlayers(); }
});
