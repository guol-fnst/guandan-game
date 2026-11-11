import assert from 'node:assert/strict';
import test from 'node:test';
import { GameRoom } from '../services/GameRoom';
import { createDeck } from './card';
import { identifyPattern } from './patterns';
import { GamePhase, Rank, Suit } from '../../../shared/types';

function setup() {
  const room = new GameRoom('timeout-test', 'p0');
  for (let i = 0; i < 4; i++) room.addPlayer(`p${i}`, `P${i}`, 2, { emit() {} });
  room.startGame();
  room.state!.currentPlayerIndex = 0;
  return room;
}

test('90-second opening timeout plays one smallest card and arms the next turn', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const room = setup();
  try {
    const deck = createDeck();
    const hand = [3, 4, 5].map(rank => deck.find(card => card.rank === rank && card.suit === Suit.Spade)!);
    room.hands.set('p0', [...hand]);
    t.mock.timers.tick(89_999);
    assert.equal(room.state!.currentPlayerIndex, 0);
    t.mock.timers.tick(1);
    assert.equal(room.state!.currentPlayerIndex, 1);
    assert.deepEqual(room.state!.lastPlay!.cards.map(card => card.id), [hand[0].id]);
    assert.equal(room.getHand('p0').length, 2);
    assert.equal(room.state!.actionDeadline, Date.now() + 90_000);
    assert.ok(room.turnTimer);
    t.mock.timers.tick(90_000);
    assert.equal(room.state!.currentPlayerIndex, 2);
    assert.equal(room.state!.passCount, 1);
  } finally { room.clearPlayers(); }
});

test('timeout may lead the heart level wildcard and finish the player', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const room = setup();
  try {
    const wild = createDeck().find(card => card.rank === Rank.Two && card.suit === Suit.Heart)!;
    room.hands.set('p0', [wild]);
    t.mock.timers.tick(90_000);
    assert.equal(room.state!.currentPlayerIndex, 1);
    assert.deepEqual(room.state!.lastPlay!.cards, [wild]);
    assert.deepEqual(room.rankings, [{ playerId: 'p0', rank: 1 }]);
    // Three timed-out followers clear the trick; the partner catches wind.
    t.mock.timers.tick(90_000);
    t.mock.timers.tick(90_000);
    t.mock.timers.tick(90_000);
    assert.equal(room.state!.currentPlayerIndex, 2);
    assert.equal(room.state!.lastPlay, null);
    assert.ok(room.turnTimer);
  } finally { room.clearPlayers(); }
});

test('AI watchdog advances after a stalled decision, including after a disconnect', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const room = setup();
  try {
    room.removePlayer('p0');
    room.players[0].isAI = true;
    // Simulate an AI request that never settles without making a network call.
    const internal = room as unknown as { startTurn(): void; aiPlay(): Promise<void> };
    internal.aiPlay = () => new Promise(() => {});
    room.state!.lastPlay = identifyPattern([createDeck()[0]], 2)!;
    room.state!.lastPlayPlayerIndex = 3;
    internal.startTurn();
    t.mock.timers.tick(500);
    assert.equal(room.state!.currentPlayerIndex, 0);
    t.mock.timers.tick(89_500);
    assert.equal(room.state!.currentPlayerIndex, 1);
    assert.equal(room.state!.passCount, 1);
    assert.equal(room.state!.phase, GamePhase.Playing);
    assert.ok(room.turnTimer);
  } finally { room.clearPlayers(); }
});
