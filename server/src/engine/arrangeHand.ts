import { Card, CardPattern, PatternType } from '../../../shared/types';
import { generateLegalPlays } from './ai';

function groupCost(pattern: CardPattern): number {
  if (pattern.type === PatternType.KingBomb) return -220;
  if (pattern.type === PatternType.FlushStraight) return -200;
  if (pattern.type.startsWith('bomb')) return 25;
  return pattern.type === PatternType.Single ? 125 : 100;
}

/** Bounded exact-cover search over legal physical groups, with a complete
 * greedy partition as the fallback. No card can be duplicated or omitted. */
export function arrangeHand(hand: Card[], level: number): CardPattern[] {
  if (!hand.length) return [];
  if (hand.length > 27) throw new Error('Hand exceeds 27 cards');
  const positions = new Map(hand.map((card, i) => [card.id, i]));
  const naturalBombs = [...new Set(hand.filter(card => card.rank <= 14).map(card => card.rank))]
    .map(rank => hand.filter(card => card.rank === rank))
    .filter(cards => cards.length >= 4)
    .map(cards => cards.reduce((mask, card) => mask | (1 << positions.get(card.id)!), 0));
  const unique = new Map<number, { mask: number; pattern: CardPattern; cost: number }>();
  for (const pattern of generateLegalPlays(hand, level)) {
    const mask = pattern.cards.reduce((bits, card) => bits | (1 << positions.get(card.id)!), 0);
    const splitPenalty = naturalBombs.reduce((total, bomb) =>
      total + ((mask & bomb) !== 0 && (mask & bomb) !== bomb ? 120 : 0), 0);
    const cost = groupCost(pattern) + splitPenalty;
    const previous = unique.get(mask);
    if (!previous || cost < previous.cost) unique.set(mask, { mask, pattern, cost });
  }
  const candidates = [...unique.values()].sort((a, b) =>
    a.cost / a.pattern.length - b.cost / b.pattern.length
    || b.pattern.length - a.pattern.length || a.pattern.rank - b.pattern.rank || a.mask - b.mask);
  const byBit = hand.map((_, i) => candidates.filter(group => group.mask & (1 << i)));
  type Partition = { cost: number; groups: typeof candidates };
  const greedy = (remaining: number): Partition => {
    const groups: typeof candidates = [];
    let cost = 0;
    for (const group of candidates) {
      if ((remaining & group.mask) !== group.mask) continue;
      remaining ^= group.mask;
      groups.push(group);
      cost += group.cost;
      if (!remaining) break;
    }
    return { cost, groups };
  };
  const memo = new Map<number, Partition>([[0, { cost: 0, groups: [] }]]);
  const deadline = performance.now() + 120;
  let nodes = 0;
  const solve = (mask: number): Partition => {
    const cached = memo.get(mask);
    if (cached) return cached;
    let best = greedy(mask);
    if (++nodes > 12000 || performance.now() >= deadline) return best;
    const first = 31 - Math.clz32(mask & -mask);
    for (const group of byBit[first]) {
      if (performance.now() >= deadline || nodes > 12000) break;
      if ((mask & group.mask) !== group.mask) continue;
      const rest = solve(mask ^ group.mask);
      if (group.cost + rest.cost < best.cost) {
        best = { cost: group.cost + rest.cost, groups: [group, ...rest.groups] };
      }
    }
    memo.set(mask, best);
    return best;
  };
  return solve(2 ** hand.length - 1).groups
    .sort((a, b) => a.cost - b.cost || b.pattern.length - a.pattern.length || b.pattern.rank - a.pattern.rank)
    .map(group => group.pattern);
}
