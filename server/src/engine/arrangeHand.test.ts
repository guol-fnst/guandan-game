import assert from 'node:assert/strict';
import test from 'node:test';
import { Card, GamePhase, PatternType, Suit } from '../../../shared/types';
import { arrangeHand } from './arrangeHand';
import { createDeck } from './card';
import { declarePatterns } from './patterns';
import { GameRoom } from '../services/GameRoom';

function verify(hand: Card[], level: number) {
  const before = JSON.stringify(hand);
  const groups = arrangeHand(hand, level);
  assert.equal(JSON.stringify(hand), before);
  assert.deepEqual(groups.flatMap(group => group.cards.map(card => card.id)).sort((a, b) => a - b),
    hand.map(card => card.id).sort((a, b) => a - b));
  for (const group of groups) {
    assert.ok(declarePatterns(group.cards, level).some(pattern => pattern.type === group.type && pattern.rank === group.rank),
      `${group.type}:${group.rank} must be legal`);
  }
  return groups;
}

test('arrangement finds two full houses and preserves every physical card', () => {
  const deck = createDeck();
  const hand = [[3, 3], [4, 2], [5, 3], [6, 2]].flatMap(([rank, count]) => deck.filter(c => c.rank === rank).slice(0, count));
  const groups = verify(hand, 2);
  assert.equal(groups.length, 2);
  assert.ok(groups.every(group => group.type === PatternType.TriplePair));
});

test('reference hand groups a wildcard flush straight and a natural bomb', () => {
  const deck = createDeck();
  const used = new Set<number>();
  const take = (rank: number, suit: Suit) => {
    const card = deck.find(c => c.rank === rank && c.suit === suit && !used.has(c.id))!;
    assert.ok(card);
    used.add(card.id);
    return card;
  };
  const hand = [take(15, Suit.Spade), take(6, Suit.Heart), take(6, Suit.Club), take(6, Suit.Diamond),
    take(14, Suit.Spade), take(14, Suit.Club), take(12, Suit.Heart),
    ...[11, 10, 9, 8].map(rank => take(rank, Suit.Spade)),
    take(9, Suit.Club), take(9, Suit.Club), take(8, Suit.Spade), take(7, Suit.Heart),
    take(5, Suit.Heart), take(5, Suit.Heart), take(5, Suit.Spade), take(5, Suit.Spade), take(4, Suit.Club),
    take(3, Suit.Diamond), take(3, Suit.Club), take(3, Suit.Heart), take(3, Suit.Heart),
    take(2, Suit.Spade), take(2, Suit.Club), take(2, Suit.Club)];
  const groups = verify(hand, 6);
  assert.ok(groups.some(group => group.type === PatternType.FlushStraight));
  assert.ok(groups.some(group => group.type === PatternType.Bomb4 && group.rank === 3));
});

test('arrangement handles empty hands, jokers, A-low runs and duplicate suits', () => {
  assert.deepEqual(arrangeHand([], 2), []);
  const deck = createDeck();
  verify(deck.filter(c => c.rank >= 15), 2);
  verify([14, 2, 3, 4, 5].map(rank => deck.find(c => c.rank === rank && c.suit === Suit.Club)!), 8);
  let seed = 817;
  for (let sample = 0; sample < 8; sample++) {
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    verify(shuffled.slice(0, 27), sample + 2);
  }
});

test('only seated players can arrange their own hand without changing turn state', () => {
  const room = new GameRoom('arrange-test', 'p0');
  for (let i = 0; i < 4; i++) room.addPlayer(`p${i}`, `P${i}`, 2, null);
  try {
    assert.equal(room.getArrangedHand('p0'), null);
    room.startGame();
    assert.equal(room.getArrangedHand('spectator'), null);
    const snapshot = JSON.stringify(room.state);
    const timer = room.turnTimer;
    assert.ok(room.getArrangedHand('p1')!.length);
    assert.equal(JSON.stringify(room.state), snapshot);
    assert.equal(room.turnTimer, timer);
    room.state!.phase = GamePhase.RoundEnd;
    assert.equal(room.getArrangedHand('p0'), null);
  } finally { room.clearPlayers(); }
});
