import assert from 'node:assert/strict';
import test from 'node:test';
import { GameRoom } from '../services/GameRoom';
import { createDeck } from './card';
import { Card } from '../../../shared/types';

function setup(handSize: number) {
  const reports: number[] = [];
  const room = new GameRoom('报牌测试', 'p0');
  const socket = { emit(event: string, data: any) {
    if (event === 'card_count_report' && data.playerId === 'p0') reports.push(data.count);
  } };
  for (let i = 0; i < 4; i++) room.addPlayer(`p${i}`, `玩家${i}`, 2, i === 0 ? socket : null);
  room.startGame();
  const deck = createDeck();
  room.hands.set('p0', Array.from({ length: handSize }, (_, i) => deck.find(c => c.rank === i + 3)!));
  const play = (cards: Card[]) => {
    room.state!.currentPlayerIndex = 0;
    room.state!.lastPlay = null;
    room.state!.passCount = 0;
    assert.equal(room.playCards('p0', cards).success, true);
  };
  return { room, reports, play };
}

test('reports once at ten cards and again at six, without repeating below either threshold', () => {
  const { room, reports, play } = setup(11);
  try {
    for (let i = 0; i < 6; i++) play([room.hands.get('p0')![0]]);
    assert.deepEqual(reports, [10, 6]);
  } finally { room.clearPlayers(); }
});

test('reports the actual count when a multi-card play jumps below six', () => {
  const { room, reports, play } = setup(11);
  try {
    play([room.hands.get('p0')![0]]);
    play(room.hands.get('p0')!.slice(0, 5));
    assert.deepEqual(reports, [10, 5]);
  } finally { room.clearPlayers(); }
});

test('entering six-card range directly emits only one report', () => {
  const { room, reports, play } = setup(7);
  try {
    play([room.hands.get('p0')![0]]);
    assert.deepEqual(reports, [6]);
  } finally { room.clearPlayers(); }
});

test('finishing a hand does not announce zero cards', () => {
  const { room, reports, play } = setup(1);
  try {
    play(room.hands.get('p0')!.slice());
    assert.deepEqual(reports, []);
  } finally { room.clearPlayers(); }
});
