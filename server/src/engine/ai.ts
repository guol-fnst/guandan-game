import { AiModelSelection, Card, CardPattern, PatternType, Rank, Suit } from '../../../shared/types';
import { effectiveRank, isJoker } from './card';
import {
  isWildCard, validWildSubstitutions,
} from './patterns';
import { canBeat, isBombPattern } from './compare';
import { llmFindBestPlay } from './llmAi';
import type { AiDecisionContext } from './llmAi';
import { analyzeDecision, analyzeEndgameRoutes, analysisKey, buildPublicKnowledge, buildTeamPlan, createTurnEstimator, publicControlEvidence } from './aiAnalysis';
import type { DecisionAnalysis, SampleResult, TeamPlan, PublicKnowledge } from './aiAnalysis';

function getRankCounts(hand: Card[]): Map<number, Card[]> {
  const map = new Map<number, Card[]>();
  for (const c of hand) {
    const list = map.get(c.rank) || [];
    list.push(c);
    map.set(c.rank, list);
  }
  return map;
}

function generateSingles(hand: Card[]): Card[][] {
  return hand.map(c => [c]);
}

function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (size < 0 || size > items.length) return [];
  const result: T[][] = [];
  const visit = (start: number, selected: T[]) => {
    if (selected.length === size) {
      result.push([...selected]);
      return;
    }
    for (let index = start; index <= items.length - (size - selected.length); index++) {
      selected.push(items[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return result;
}

function rankRuns(length: 2 | 3 | 5): Rank[][] {
  const runs: Rank[][] = [[
    Rank.Ace,
    ...Array.from({ length: length - 1 }, (_, index) => (Rank.Two + index) as Rank),
  ]];
  for (let start = Rank.Two; start + length - 1 <= Rank.Ace; start++) {
    runs.push(Array.from({ length }, (_, index) => (start + index) as Rank));
  }
  return runs;
}

interface TargetGroup {
  rank: Rank;
  count: number;
  suit?: Suit;
}

/**
 * Enumerate physical ways to fill fixed rank groups. 逢人配 may replace a
 * missing ordinary card, including one which is otherwise available; keeping
 * those alternatives lets the scorer choose the least damaging decomposition.
 */
function generateGroupedPatterns(
  regulars: Card[],
  wilds: Card[],
  groups: TargetGroup[],
  type: PatternType,
  patternRank: Rank,
  add: (pattern: CardPattern) => void,
) {
  const visit = (
    groupIndex: number,
    cards: Card[],
    substitutionTargets: Array<{ rank: Rank; suit: Suit }>,
  ) => {
    if (groupIndex === groups.length) {
      for (const selectedWilds of combinations(wilds, substitutionTargets.length)) {
        add({
          type,
          rank: patternRank,
          length: cards.length + selectedWilds.length,
          cards: [...cards, ...selectedWilds],
          substitutions: selectedWilds.map((card, index) => ({
            ...card,
            ...substitutionTargets[index],
          })),
        });
      }
      return;
    }
    const group = groups[groupIndex];
    const candidates = regulars.filter(card =>
      card.rank === group.rank && (group.suit === undefined || card.suit === group.suit)
    );
    const minimumNatural = group.rank > Rank.Ace
      ? group.count
      : Math.max(0, group.count - (wilds.length - substitutionTargets.length));
    const maximumNatural = Math.min(group.count, candidates.length);
    for (let naturalCount = minimumNatural; naturalCount <= maximumNatural; naturalCount++) {
      const missing = group.count - naturalCount;
      if (substitutionTargets.length + missing > wilds.length) continue;
      for (const selected of combinations(candidates, naturalCount)) {
        const resolvedSuit = group.suit ?? Suit.Spade;
        visit(
          groupIndex + 1,
          [...cards, ...selected],
          [...substitutionTargets, ...Array.from({ length: missing }, () => ({
            rank: group.rank,
            suit: resolvedSuit,
          }))],
        );
      }
    }
  };
  visit(0, [], []);
}

export function generateLegalPlays(
  hand: Card[],
  currentLevel: number
): CardPattern[] {
  const wilds = hand.filter(card => isWildCard(card, currentLevel));
  const regulars = hand.filter(card => !isWildCard(card, currentLevel));
  const patterns: CardPattern[] = [];
  const seen = new Set<string>();

  const add = (pattern: CardPattern) => {
    if (!validWildSubstitutions(pattern.cards, pattern.substitutions || [], currentLevel)) return;
    const ids = pattern.cards.map(card => card.id).sort((a, b) => a - b);
    const key = `${pattern.type}:${pattern.rank}:${ids.join(',')}`;
    if (new Set(ids).size !== ids.length || seen.has(key)) return;
    seen.add(key);
    patterns.push(pattern);
  };

  for (const cards of generateSingles(hand)) {
    add({ type: PatternType.Single, rank: cards[0].rank, length: 1, cards });
  }

  // Same-rank groups. Pairs may be made from jokers; larger groups may not.
  for (let rank = Rank.Two; rank <= Rank.BigJoker; rank++) {
    generateGroupedPatterns(regulars, wilds, [{ rank, count: 2 }], PatternType.Pair, rank, add);
    if (rank <= Rank.Ace) {
      generateGroupedPatterns(regulars, wilds, [{ rank, count: 3 }], PatternType.Triple, rank, add);
      for (let size = 4; size <= 10; size++) {
        generateGroupedPatterns(
          regulars, wilds, [{ rank, count: size }],
          `bomb${size}` as PatternType, rank, add,
        );
      }
    }
  }

  for (let tripleRank = Rank.Two; tripleRank <= Rank.Ace; tripleRank++) {
    for (let pairRank = Rank.Two; pairRank <= Rank.BigJoker; pairRank++) {
      if (tripleRank === pairRank) continue;
      generateGroupedPatterns(regulars, wilds, [
        { rank: tripleRank, count: 3 },
        { rank: pairRank, count: 2 },
      ], PatternType.TriplePair, tripleRank, add);
    }
  }

  for (const run of rankRuns(5)) {
    const groups = run.map(rank => ({ rank, count: 1 }));
    generateGroupedPatterns(regulars, wilds, groups, PatternType.Straight, run[run.length - 1], pattern => {
      const substitutions = pattern.substitutions || [];
      const resolved = pattern.cards.map(card => substitutions.find(item => item.id === card.id) || card);
      if (resolved.every(card => card.suit === resolved[0].suit)) {
        // A wildcard can deliberately take another suit to declare an ordinary
        // straight. Natural straight flushes cannot be downgraded this way.
        if (substitutions.length === 0) return;
        pattern.substitutions = substitutions.map((card, index) => index === 0
          ? { ...card, suit: resolved[0].suit === Suit.Spade ? Suit.Heart : Suit.Spade }
          : card);
      }
      add(pattern);
    });
    for (const suit of [Suit.Spade, Suit.Heart, Suit.Club, Suit.Diamond]) {
      generateGroupedPatterns(
        regulars, wilds, run.map(rank => ({ rank, count: 1, suit })),
        PatternType.FlushStraight, run[run.length - 1], add,
      );
    }
  }

  for (const run of rankRuns(3)) {
    generateGroupedPatterns(
      regulars, wilds, run.map(rank => ({ rank, count: 2 })),
      PatternType.ConsecutivePair, run[run.length - 1], add,
    );
  }
  for (const run of rankRuns(2)) {
    generateGroupedPatterns(
      regulars, wilds, run.map(rank => ({ rank, count: 3 })),
      PatternType.Plane, run[run.length - 1], add,
    );
  }

  const jokers = hand.filter(isJoker);
  if (jokers.length === 4) {
    add({ type: PatternType.KingBomb, rank: Rank.BigJoker, length: 4, cards: jokers });
  }

  return patterns;
}

function strategicPlayKey(play: CardPattern): string {
  const cards = play.cards
    .map(card => `${card.suit}${card.rank}`)
    .sort()
    .join(',');
  return `${play.type}:${play.rank}:${play.length}:${cards}`;
}

function dedupeStrategicPlays(plays: CardPattern[]): CardPattern[] {
  const seen = new Set<string>();
  return plays.filter(play => {
    const key = strategicPlayKey(play);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyStrategicGuards(
  plays: CardPattern[],
  hand: Card[],
  currentLevel: number,
  isFreePlay: boolean,
  context?: AiDecisionContext,
): CardPattern[] {
  let guarded = plays;

  // Preserve 逢人配 instead of wasting it as a single. The only exception is an
  // urgent block when an opponent has one card and no safer legal play exists.
  if (hand.length > 1) {
    const withoutWildSingles = guarded.filter(play => !(
      play.type === PatternType.Single && isWildCard(play.cards[0], currentLevel)
    ));
    const opponentReportedSingle = context?.players.some(player =>
      player.relation === 'opponent' && player.finishRank === null && player.cardCount === 1
    ) || false;
    if (withoutWildSingles.length > 0 || !opponentReportedSingle) {
      guarded = withoutWildSingles;
    }
  }

  // Keep larger singles and partner-overtaking actions available for analysis.
  // The final policy enforces cooperation and low-first with evidence-based exceptions.

  return guarded;
}

/**
 * Round-level urgency multiplier, 1.0 = neutral. Above 1 the AI fights harder
 * this hand (trailing on levels, defending the table against a near-Ace
 * opponent, later rounds of a finite match); below 1 a comfortable lead plays
 * conservatively. Drives bomb willingness and blocking urgency so decisions
 * follow the match score, not just the cards. Uses only public context.
 */
export function roundStake(context?: AiDecisionContext): number {
  if (!context) return 1;
  const ourTeam = context.selfSeatIndex % 2;
  const gap = context.teamLevels[ourTeam] - context.teamLevels[1 - ourTeam];
  const leading = context.leadingTeam === ourTeam;
  const opponentNearAce = context.teamLevels[1 - ourTeam] >= Rank.Ace - 2;
  let stake = 1;
  if (gap < 0) stake += Math.min(3, -gap) * 0.12;
  else if (leading && gap >= 2) stake -= Math.min(2, gap) * 0.05;
  if (leading && opponentNearAce) stake += 0.15;
  stake += Math.min(4, Math.max(0, context.roundNumber - 1)) * 0.02;
  return stake;
}

/** Base7-inspired value: prefer shedding groups while preserving controls and structures. */
export function scorePlay(
  play: CardPattern,
  hand: Card[],
  currentLevel: number,
  isFreePlay: boolean,
  context?: AiDecisionContext,
  protectedCardIds: ReadonlySet<number> = new Set(),
  teamPlan?: TeamPlan,
): number {
  if (play.cards.length === hand.length) return 1_000_000;
  const handCounts = getRankCounts(hand);
  const playedCounts = getRankCounts(play.cards);
  const lastPlayer = context?.players.find(player => player.seatIndex === context.lastPlayPlayerIndex);
  const partnerLed = lastPlayer?.relation === 'partner';
  const opponentLed = lastPlayer?.relation === 'opponent';
  const urgentOpponent = context?.players.some(player =>
    player.relation === 'opponent' && player.finishRank === null && player.cardCount <= 5
  ) || false;

  const sequence = [PatternType.Straight, PatternType.ConsecutivePair, PatternType.Plane,
    PatternType.FlushStraight].includes(play.type);
  const stake = roundStake(context);
  // effectiveRank deliberately jumps level cards/jokers to 99/100/101 for
  // legality comparison. Reusing that discontinuous scale as a resource cost
  // charged a joker roughly 600 points and then charged it again below. Keep a
  // compact strategic order here; explicit wildcard/joker costs retain their
  // option value without making them practically unplayable.
  const strategicRank = play.rank === currentLevel ? 15
    : play.rank === Rank.SmallJoker ? 16
      : play.rank === Rank.BigJoker ? 17 : play.rank;
  const sheddingValue = isFreePlay ? 30 : 120;
  let score = play.cards.length * sheddingValue - (sequence ? play.rank : strategicRank) * 6;
  if (play.cards.length > 1) score += 100;
  if ([PatternType.Straight, PatternType.TriplePair, PatternType.ConsecutivePair, PatternType.Plane].includes(play.type)) {
    score += 100;
  }

  // A card which belongs to a bomb/king bomb/flush straight or is a wildcard
  // has high option value. Penalise partial destruction, not playing it whole.
  for (const [rank, selected] of playedCounts) {
    const held = handCounts.get(rank)?.length || 0;
    if (held >= 4 && selected.length < held) score -= 650;
    // Ordinary group damage is measured from the remaining combinations in
    // orderCandidates, rather than charging every split the same fixed price.
  }
  // Attachments do not strengthen a full house. Price the control pair
  // separately from its triple rank, including declared wildcard substitutes.
  if (play.type === PatternType.TriplePair) {
    const substitutions = new Map((play.substitutions || []).map(card => [card.id, card]));
    const declared = new Map<Rank, number>();
    for (const card of play.cards) {
      const rank = (substitutions.get(card.id) || card).rank;
      declared.set(rank, (declared.get(rank) || 0) + 1);
    }
    const pairRank = [...declared].find(([, count]) => count === 2)?.[0];
    if (pairRank !== undefined) score -= pairRank >= Rank.SmallJoker ? 360
      : pairRank === currentLevel ? 240 : pairRank === Rank.Ace ? 100 : pairRank === Rank.King ? 60 : 0;
  }

  // A-2-3 / 2-3-4 pairs are low tricks even though level/A pairs are controls.
  if (play.type === PatternType.ConsecutivePair && play.rank <= Rank.Four) {
    score -= play.cards.reduce((cost, card) => cost + (card.rank === currentLevel ? 160
      : card.rank === Rank.Ace ? 80 : 0), 0);
  }

  if (!isBombPattern(play)) {
    const late = hand.length <= 10 || context?.players.some(p => p.finishRank === null && p.cardCount <= 5);
    score -= play.cards.filter(card => isWildCard(card, currentLevel)).length * (late ? 90 : 260);
    score -= play.cards.filter(isJoker).length * (late ? 35 : 100);
    score -= play.cards.filter(card => protectedCardIds.has(card.id)).length * 90;
  }

  if (isBombPattern(play)) {
    // Taking the trick with a bomb has the same immediate benefit regardless
    // of size. Cancel the generic shedding bonus and charge for bomb strength;
    // whole-hand finishes still take priority above. Keep leading costs finite
    // so intact bombs beat dismantling the only remaining structures. The cost
    // scales inversely with the round stake: a trailing team spends bombs to
    // take control, a leading team hoards them for defense.
    const tier = play.type === PatternType.KingBomb ? 8
      : play.type === PatternType.FlushStraight ? 1.5 : play.cards.length - 4;
    // Urgency decides whether a bomb is worth spending, but must never make a
    // larger sufficient bomb cheaper than a smaller one. Cancel the generic
    // shedding reward unconditionally and only discount part of the tier cost.
    score -= play.cards.length * sheddingValue + 100;
    score -= tier * (100 + 40 * (2 - stake));
    // Apply match urgency equally to every bomb so it affects the bomb/pass
    // decision without reversing the ordering between sufficient bombs.
    score += (stake - 1) * 400;
    if (partnerLed) score -= 1000;
    if (opponentLed && lastPlayer && lastPlayer.cardCount <= 14) score += 650 * stake;
    if (urgentOpponent) score += 600 * stake;
  }

  if (!isFreePlay && !isBombPattern(play)) score += 350 * stake;
  if (partnerLed) score -= 500;

  if (isFreePlay && context) {
    const plan = teamPlan ?? buildTeamPlan(hand, [], context);
    const opponents = context.players.filter(player => player.relation === 'opponent' && player.finishRank === null);
    if (opponents.some(player => player.cardCount === play.cards.length)) score -= 350;

    // Shape the lead for a reported partner, not merely for an exact whole-hand
    // match. Lower leads remain preferable through the generic rank cost.
    if (plan.goal === 'feed_partner' && play.type === plan.feedType) score += 520 * stake;
    const nextSeat = (context.selfSeatIndex + 1) % 4;
    for (const opponent of opponents) {
      const exposesReportedShape = opponent.cardCount === 1 && play.type === PatternType.Single
        || opponent.cardCount === 2 && play.type === PatternType.Pair;
      if (exposesReportedShape) score -= opponent.seatIndex === nextSeat ? 900 : 260;
    }
  }

  if (context && (play.type === PatternType.Single || play.type === PatternType.Pair)) {
    const evidence = publicControlEvidence(play, hand, currentLevel, context);
    // A known control is valuable to retain, not a reason to open high in a
    // calm position. Spend it to contest a trick or meet an urgent threat.
    if (evidence?.unbeatable) score += isFreePlay ? (urgentOpponent ? 260 : 0) : 420;
  }

  // Round-outcome shaping from finish ranks: partner already first means our
  // own finish is worth a 双上 (+3), so shed aggressively; an opponent already
  // first means the other opponent's rank decides the upgrade we concede, so
  // block their tricks harder.
  const partnerHead = context?.players.some(player =>
    player.relation === 'partner' && player.finishRank === 1);
  const opponentHead = context?.players.some(player =>
    player.relation === 'opponent' && player.finishRank === 1);
  if (partnerHead && !isBombPattern(play)) score += play.cards.length * 25;
  if (opponentHead && lastPlayer?.relation === 'opponent') score += 400 * stake;

  // Prefer the weakest physical realization when declarations are equivalent.
  score -= play.cards.reduce((sum, card) => sum + effectiveRank(card.rank, currentLevel), 0) / 20;
  return score;
}

/** A concrete low-cost takeover exception for the middle game, where paired
 * rollout evidence is usually unavailable. Preserve a teammate near finishing. */
function productivePartnerTakeover(
  play: CardPattern, hand: Card[], allPlays: CardPattern[], last: CardPattern | null,
  level: number, context?: AiDecisionContext,
): boolean {
  if (!context || !last || context.lastPlayPlayerIndex !== context.partnerSeatIndex) return false;
  const partner = context.players.find(player => player.relation === 'partner');
  if (!partner || partner.finishRank !== null || partner.cardCount < 6 || passPosition(context).closesTrick) return false;
  if (![PatternType.Single, PatternType.Pair].includes(play.type) || isBombPattern(last)
    || effectiveRank(last.rank, level) > Rank.Ten
    || effectiveRank(play.rank, level) < effectiveRank(Rank.Ace, level)) return false;
  if (context.players.some(player => player.relation === 'opponent' && player.finishRank === null
    && player.cardCount <= 2)) return false;
  const counts = getRankCounts(hand);
  if (play.cards.some(card => isWildCard(card, level)
    || (counts.get(card.rank)?.length || 0) !== play.cards.length)) return false;
  const used = new Set(play.cards.map(card => card.id));
  const remaining = hand.length - used.size;
  // The retained group must actually exist and use no card spent taking over.
  return remaining >= 3 && allPlays.some(exit => exit.cards.length === remaining
    && exit.cards.every(card => !used.has(card.id)));
}

function scoreTeamPlan(
  play: CardPattern, hand: Card[], allPlays: CardPattern[], level: number,
  free: boolean, plan: TeamPlan, context?: AiDecisionContext,
  memory: PublicKnowledge | null = null,
): number {
  if (!context || play.cards.length === hand.length) return 0;
  const used = new Set(play.cards.map(card => card.id));
  const remaining = hand.filter(card => !used.has(card.id));
  let score = 0;
  if (!free) {
    const last = [...(context.actionHistory || context.recentActions)].reverse()
      .find(action => action.action === 'play')?.pattern || null;
    if (productivePartnerTakeover(play, hand, allPlays, last, level, context)) score += 1100;
    else if (context.lastPlayPlayerIndex !== context.partnerSeatIndex
      && !isBombPattern(play) && effectiveRank(play.rank, level) >= effectiveRank(Rank.Ace, level)
      && remaining.length >= 3 && allPlays.some(exit => exit.cards.length === remaining.length
        && exit.cards.every(card => !used.has(card.id)))) score += 220;
  }
  if (plan.goal === 'finish_self') {
    score += play.cards.length * 20;
  } else if (plan.goal === 'block_opponent') {
    if (!free && context.lastPlayPlayerIndex === plan.threatSeat) score += 120;
  } else if (plan.goal === 'feed_partner') {
    const feed = allPlays.find(candidate => candidate.type === plan.feedType
      && effectiveRank(candidate.rank, level) < Rank.Queen
      && candidate.cards.every(card => !used.has(card.id)));
    const opponentLed = context.players.some(p => p.seatIndex === context.lastPlayPlayerIndex
      && p.relation === 'opponent');
    // Taking control only helps the plan if a suitable low lead remains.
    if (!free && opponentLed && feed && (isBombPattern(play)
      || effectiveRank(play.rank, level) >= effectiveRank(Rank.Ace, level))) score += 180;
    if (free && play.type === plan.feedType && memory) {
      const partner = memory.knownBySeat[context.partnerSeatIndex];
      if (partner.length === play.length && partner.every(card => card.rank === partner[0].rank)) {
        score += effectiveRank(partner[0].rank, level) > effectiveRank(play.rank, level) ? 150 : -520;
      }
    }
  }
  // Public memory: retain an appropriate control against a reported opponent.
  // No bomb guarantee is implied; a high unseen single may still beat it.
  if (memory && [PatternType.Single, PatternType.Pair].includes(play.type)) {
    const reported = context.players.some(p => p.relation === 'opponent'
      && p.finishRank === null && p.cardCount === play.length);
    if (reported) {
      const retained = allPlays.some(candidate => candidate.type === play.type
        && candidate.cards.every(card => !used.has(card.id))
        && memory.unseen.every(card => effectiveRank(card.rank, level) <= effectiveRank(candidate.rank, level)));
      if (retained && remaining.length > 0) score += 100;
    }
  }
  return score;
}

export interface CompressedAiCandidates {
  plays: CardPattern[];
  /** Number of equivalent physical choices represented by each model action. */
  equivalentCounts: number[];
}

const MODEL_ACTION_LIMIT = 96;

/** Bound prompt size without deleting an entire strategic family. Input is
 * already heuristic-ordered; round-robin selection preserves representatives
 * from every pattern type before taking deeper alternatives. */
export function limitModelCandidates(
  compressed: CompressedAiCandidates, limit = MODEL_ACTION_LIMIT,
): CompressedAiCandidates {
  if (compressed.plays.length <= limit) return compressed;
  const buckets = new Map<PatternType, number[]>();
  compressed.plays.forEach((play, index) => {
    const bucket = buckets.get(play.type) || [];
    bucket.push(index);
    buckets.set(play.type, bucket);
  });
  const selected = new Set<number>([0]);
  for (let row = 0; selected.size < limit; row++) {
    let added = false;
    for (const bucket of buckets.values()) {
      const index = bucket[row];
      if (index !== undefined && selected.size < limit) {
        selected.add(index);
        added = true;
      }
    }
    if (!added) break;
  }
  const indices = [...selected].sort((left, right) => left - right);
  return {
    plays: indices.map(index => compressed.plays[index]),
    equivalentCounts: indices.map(index => compressed.equivalentCounts[index]),
  };
}

/**
 * Preserve every distinct declared strategy while merging choices which differ
 * only by equivalent physical cards. Because input is already Base7 ordered,
 * the retained representative is the least damaging concrete realization.
 */
export function compressCandidatesForModel(
  ordered: CardPattern[],
  currentLevel: number,
): CompressedAiCandidates {
  const groups = new Map<string, { play: CardPattern; count: number }>();
  for (const play of ordered) {
    const substitutions = new Map((play.substitutions || []).map(card => [card.id, card]));
    const resolvedCounts = new Map<number, number>();
    for (const card of play.cards) {
      const resolved = substitutions.get(card.id) || card;
      resolvedCounts.set(resolved.rank, (resolvedCounts.get(resolved.rank) || 0) + 1);
    }
    const declaredRanks = [...resolvedCounts]
      .sort(([left], [right]) => left - right)
      .map(([rank, count]) => `${rank}x${count}`)
      .join(',');
    const wildcardCount = play.cards.filter(card => isWildCard(card, currentLevel)).length;
    const flushSuit = play.type === PatternType.FlushStraight
      ? (substitutions.get(play.cards[0]?.id) || play.cards[0])?.suit || ''
      : '';
    const key = `${play.type}:${play.rank}:${play.length}:${declaredRanks}:w${wildcardCount}:s${flushSuit}`;
    const existing = groups.get(key);
    if (existing) existing.count++;
    else groups.set(key, { play, count: 1 });
  }
  const values = [...groups.values()];
  return {
    plays: values.map(value => value.play),
    equivalentCounts: values.map(value => value.count),
  };
}

/** Compare whole-hand routes, not just the number of cards shed now.
 * Reuse physical candidates: a residual combination must use no played cards.
 * The bounded estimator is an approximation when its search budget expires. */
export function remainingStructureScores(
  hand: Card[], plays: CardPattern[], allPlays: CardPattern[], level: number,
  analysis?: DecisionAnalysis,
): Map<CardPattern, number> {
  const estimator = createTurnEstimator(hand, allPlays, performance.now() + 4);
  const whole = analysis?.handTurns ?? estimator.whole();
  const counts = getRankCounts(hand);
  const groups = allPlays.filter(play => play.cards.length > 1);
  const scores = new Map<CardPattern, number>();
  const residualDamage = (remaining: Card[], available: CardPattern[]) => {
    const groupedIds = new Set(available.flatMap(group => group.cards.map(card => card.id)));
    const residualCounts = getRankCounts(remaining);
    let damage = 0;
    for (const [rank, cards] of residualCounts) {
      // High singles/pairs are controls; low isolated cards are liabilities.
      if (effectiveRank(rank, level) >= Rank.Queen) continue;
      const split = cards.length < (counts.get(rank)?.length || 0);
      if (cards.length === 1 && !groupedIds.has(cards[0].id)) {
        damage += split ? 160 : 55;
      } else if (cards.length === 2 && !available.some(group =>
        group.cards.length > 2 && cards.every(card => group.cards.some(c => c.id === card.id)))) {
        damage += split ? 65 : 25;
      }
    }
    return damage;
  };
  // PASS retains the current structure. Measure damage relative to that same
  // baseline instead of charging only the play for already stranded cards.
  const baselineDamage = residualDamage(hand, groups);
  for (const play of plays) {
    const used = new Set(play.cards.map(card => card.id));
    const remaining = hand.filter(card => !used.has(card.id));
    const available = groups.filter(group => group.cards.every(card => !used.has(card.id)));
    const after = analysis?.candidates[analysisKey(play)]?.remainingTurns ?? estimator.after(play);
    // Approximate partitions carry less weight than fully searched partitions.
    const weight = whole.exact && after.exact ? 420 : 240;
    scores.set(play, weight * (whole.turns - after.turns - 1)
      - residualDamage(remaining, available) + baselineDamage);
  }
  return scores;
}

function orderCandidates(
  plays: CardPattern[],
  hand: Card[],
  currentLevel: number,
  isFreePlay: boolean,
  context?: AiDecisionContext,
  analysis?: DecisionAnalysis,
  allPlays?: CardPattern[],
  evaluatedScores?: Map<CardPattern, number>,
): CardPattern[] {
  const wholeHandPlays = allPlays ?? generateLegalPlays(hand, currentLevel);
  const teamPlan = analysis?.teamPlan ?? buildTeamPlan(hand, wholeHandPlays, context);
  const endgameRoutes = isFreePlay ? analyzeEndgameRoutes(hand, wholeHandPlays, currentLevel, context) : {};
  const memory = context ? buildPublicKnowledge(hand, context) : null;
  // Evaluate retained same-type controls for every candidate before truncating
  // the model input. A higher disjoint play is potential recapture, not proof
  // that it can beat an opponent's unknown response.
  const controls = new Map<string, CardPattern[]>();
  for (const play of plays) {
    const key = `${play.type}:${play.length}`;
    const group = controls.get(key) || [];
    group.push(play);
    controls.set(key, group);
  }
  for (const group of controls.values()) group.sort((a, b) =>
    canBeat(a, b, currentLevel) ? -1 : canBeat(b, a, currentLevel) ? 1 : 0);
  const recaptureBonus = (play: CardPattern) => {
    const used = new Set(play.cards.map(card => card.id));
    const retained = controls.get(`${play.type}:${play.length}`)?.find(control =>
      canBeat(control, play, currentLevel) && control.cards.every(card => !used.has(card.id)));
    if (!retained) return 0;
    const strength = effectiveRank(retained.rank, currentLevel);
    // Low reserve cards are weak evidence of recapture; even A is not a lock.
    return strength >= effectiveRank(Rank.Ace, currentLevel) ? 75 : 20;
  };
  const protectedCardIds = new Set(plays
    .filter(play => play.type === PatternType.FlushStraight || play.type === PatternType.KingBomb)
    .flatMap(play => play.cards.map(card => card.id)));
  const structure = remainingStructureScores(
    hand, plays, wholeHandPlays, currentLevel, analysis,
  );
  const counts = getRankCounts(hand);
  const sequenceIds = new Set(wholeHandPlays
    .filter(play => [PatternType.Straight, PatternType.FlushStraight,
      PatternType.ConsecutivePair, PatternType.Plane].includes(play.type))
    .flatMap(play => play.cards.map(card => card.id)));
  const opponentLed = !isFreePlay && context?.players.some(player =>
    player.seatIndex === context.lastPlayPlayerIndex && player.relation === 'opponent');
  const scores = evaluatedScores ?? new Map<CardPattern, number>();
  for (const play of plays) {
    const card = play.cards[0];
    // A loose singleton is useful to shed, but a unique rank in a sequence
    // is not a loose card. This preference never bypasses structure or PASS.
    const looseBonus = opponentLed && play.type === PatternType.Single
      && counts.get(card.rank)?.length === 1 && !isJoker(card)
      && !isWildCard(card, currentLevel) && !sequenceIds.has(card.id) ? 80 : 0;
    scores.set(play, scorePlay(play, hand, currentLevel, isFreePlay, context, protectedCardIds, teamPlan)
      + recaptureBonus(play) + (structure.get(play) || 0) + looseBonus
      + (endgameRoutes[analysisKey(play)]?.score || 0)
      + scoreTeamPlan(play, hand, wholeHandPlays, currentLevel, isFreePlay, teamPlan, context, memory));
  }
  return [...plays].sort((a, b) => scores.get(b)! - scores.get(a)!);
}

/**
 * Guandan endgame defence against the clockwise next player: once the AI has
 * decided to play the reported shape, it must use its strongest legal one.
 * This deliberately does not force a single/pair lead or turn a PASS into a
 * play; it only replaces a chosen single/pair with the largest equivalent.
 */
export function enforceReportedNextPlayerMaximum(
  proposed: CardPattern | null,
  candidates: CardPattern[],
  nextPlayerCardCount: number,
  level: number,
): CardPattern | null {
  if (!proposed) return proposed;
  const requiredType = nextPlayerCardCount === 1
    ? PatternType.Single
    : nextPlayerCardCount === 2
      ? PatternType.Pair
      : null;
  if (requiredType === null || proposed.type !== requiredType) return proposed;

  const sameType = candidates.filter(play => play.type === requiredType);
  return sameType.reduce((strongest, play) =>
    canBeat(play, strongest, level) ? play : strongest, proposed);
}

function enforceNextPlayerReport(
  proposed: CardPattern | null,
  candidates: CardPattern[],
  level: number,
  context?: AiDecisionContext,
): CardPattern | null {
  if (!context) return proposed;
  const nextSeatIndex = (context.selfSeatIndex + 1) % 4;
  const nextPlayer = context.players.find(player => player.seatIndex === nextSeatIndex);
  if (!nextPlayer || nextPlayer.finishRank !== null) return proposed;
  return enforceReportedNextPlayerMaximum(proposed, candidates, nextPlayer.cardCount, level);
}

function retainNextPlayerReportMaximum(
  selected: CardPattern[],
  allCandidates: CardPattern[],
  level: number,
  context?: AiDecisionContext,
): CardPattern[] {
  if (!context || selected.length === 0) return selected;
  const nextSeatIndex = (context.selfSeatIndex + 1) % 4;
  const nextPlayer = context.players.find(player => player.seatIndex === nextSeatIndex);
  const requiredType = nextPlayer?.finishRank === null && nextPlayer.cardCount === 1
    ? PatternType.Single
    : nextPlayer?.finishRank === null && nextPlayer.cardCount === 2
      ? PatternType.Pair
      : null;
  if (requiredType === null) return selected;
  const matching = allCandidates.filter(play => play.type === requiredType);
  if (matching.length === 0) return selected;
  const strongest = matching.reduce((best, play) => canBeat(play, best, level) ? play : best);
  if (selected.includes(strongest)) return selected;
  return [...selected.slice(0, -1), strongest];
}

export function findBestPlay(
  hand: Card[],
  lastPattern: CardPattern | null,
  isFreePlay: boolean,
  currentLevel: number,
  context?: AiDecisionContext,
  allPlays: CardPattern[] = generateLegalPlays(hand, currentLevel),
): CardPattern | null {
  let legalPlays = allPlays;

  if (!isFreePlay && lastPattern) {
    legalPlays = legalPlays.filter(p => canBeat(p, lastPattern, currentLevel));
  }

  if (legalPlays.length === 0) return null;
  legalPlays = dedupeStrategicPlays(legalPlays);
  const scores = new Map<CardPattern, number>();
  const ordered = orderCandidates(legalPlays, hand, currentLevel, isFreePlay, context, undefined, allPlays, scores);
  const proposed = enforceNextPlayerReport(ordered[0], legalPlays, currentLevel, context);
  if (!isFreePlay && context) {
    // The rollout policy uses this entry point too. Finite partner preferences
    // must not make simulated teammates steal tricks without a concrete plan.
    if (proposed && proposed.cards.length !== hand.length && lastPattern
      && context.lastPlayPlayerIndex === context.partnerSeatIndex
      && !blocksReportedSingle(proposed, lastPattern, hand, currentLevel, context)
      && !productivePartnerTakeover(proposed, hand, allPlays, lastPattern, currentLevel, context)) return null;
    const passScore = scorePass(hand, lastPattern, currentLevel, context);
    if (!proposed || scores.get(proposed)! <= passScore) return null;
  }
  return proposed;
}

/** The unchanged trick after our PASS: who can still respond, or who gets
 * the next lead (including catch-wind after a finished leader). */
export function passPosition(context: AiDecisionContext) {
  const active = context.players.filter(player => player.finishRank === null);
  const leader = context.players.find(player => player.seatIndex === context.lastPlayPlayerIndex);
  const needed = active.length - (leader?.finishRank === null ? 1 : 0);
  const remaining = Math.max(0, needed - (context.passCount || 0) - 1);
  const responders: number[] = [];
  for (let step = 1; step <= 4 && responders.length < remaining; step++) {
    const seat = (context.selfSeatIndex + step) % 4;
    if (seat !== context.selfSeatIndex && seat !== leader?.seatIndex
      && active.some(player => player.seatIndex === seat)) responders.push(seat);
  }
  let nextLead = leader?.seatIndex;
  if (leader && leader.finishRank !== null) {
    const partner = (leader.seatIndex + 2) % 4;
    for (let step = 0; step < 4; step++) {
      const seat = (partner + step) % 4;
      if (active.some(player => player.seatIndex === seat)) { nextLead = seat; break; }
    }
  }
  return { closesTrick: remaining === 0, responders, nextLead };
}

export function scorePass(
  hand: Card[], last: CardPattern | null, level: number, context: AiDecisionContext,
): number {
  const lastPlayer = context.players.find(player => player.seatIndex === context.lastPlayPlayerIndex);
  if (lastPlayer?.relation === 'partner') return passPosition(context).closesTrick ? 760 : 600;
  // Defensive fallback for incomplete/synthetic contexts: never pass on a
  // trick attributed to ourselves.
  if (lastPlayer?.relation === 'self') return -10_000;
  if (!last) return Number.NEGATIVE_INFINITY;
  const position = passPosition(context);
  const nextPlayer = context.players.find(player => player.seatIndex === position.responders[0]);
  const nextLeader = context.players.find(player => player.seatIndex === position.nextLead);
  let score = 250 + Math.min(150, effectiveRank(last.rank, level) * 6);
  if ((lastPlayer?.cardCount ?? 27) > 10) score += 70;
  if (lastPlayer?.finishRank === null && lastPlayer.cardCount <= 5) {
    score -= (lastPlayer.cardCount <= 1 ? 420 : lastPlayer.cardCount <= 3 ? 220 : 140) * roundStake(context);
  }
  if (position.closesTrick && nextLeader?.relation === 'opponent') {
    score -= (nextLeader.cardCount <= 3 ? 240 : 100) * roundStake(context);
  } else if (position.closesTrick && nextLeader?.relation === 'partner') score += 180;
  const controlStreak = opponentControlStreak(context);
  if (lastPlayer?.relation === 'opponent' && controlStreak > 1) {
    score -= Math.min(3, controlStreak - 1) * 140 * roundStake(context);
  }
  if (nextPlayer?.relation === 'partner' && nextPlayer.cardCount <= 5) score += 90;
  if (nextPlayer?.relation === 'opponent' && nextPlayer.cardCount <= 5) score -= 140;
  // Holding fragile resources is valuable even when their immediate response is legal.
  const counts = getRankCounts(hand);
  if ([...counts.values()].some(cards => cards.length >= 4)) score += 35;
  if (hand.some(card => isWildCard(card, level))) score += 35;

  // Passing a level single also gives up the chance to change the lead shape.
  // Spend a loose joker when there are groups to release or a reported partner
  // to feed. Do not treat a joker pair/king bomb as a disposable single, and
  // do not assume that taking this trick guarantees consecutive control.
  const looseJoker = hand.some(card => isJoker(card) && counts.get(card.rank)?.length === 1);
  const partner = context.players.find(player => player.relation === 'partner' && player.finishRank === null);
  const groupedRanks = [...counts.entries()].filter(([rank, cards]) =>
    rank < Rank.SmallJoker && cards.length >= 2).length;
  const canFeedPartner = partner && (partner.cardCount === 1
    ? hand.some(card => !isJoker(card) && !isWildCard(card, level)
      && effectiveRank(card.rank, level) < Rank.Queen && counts.get(card.rank)?.length === 1)
    : partner.cardCount === 2 && [...counts.entries()].some(([rank, cards]) =>
      cards.length === 2 && effectiveRank(rank, level) < Rank.Queen));
  if (lastPlayer?.relation === 'opponent' && last.type === PatternType.Single
    && last.rank === level && looseJoker && (groupedRanks >= 2 || canFeedPartner)) {
    score -= 250 * roundStake(context);
  }
  return score;
}

/** Number of uninterrupted plays by the current trick leader, separated only
 * by passes. This is public tempo evidence, not hidden-card inference. */
export function opponentControlStreak(context: AiDecisionContext): number {
  const leader = context.lastPlayPlayerIndex;
  if (leader < 0) return 0;
  const history = context.actionHistory || context.recentActions;
  let streak = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const action = history[index];
    if (action.action === 'pass') continue;
    if (action.seatIndex !== leader) break;
    streak++;
  }
  return streak;
}

function materiallyBetterSimulation(
  play: CardPattern, alternative: CardPattern | null, analysis?: DecisionAnalysis,
): boolean {
  const result = analysis?.candidates[analysisKey(play)]?.simulation;
  const other = alternative
    ? analysis?.candidates[analysisKey(alternative)]?.simulation : analysis?.passSimulation;
  // Small samples and marginal differences must not override team cooperation
  // or spending the weakest sufficient card. A sampled 100% is not proof.
  return reliablyBetterSimulation(result, other);
}

export function reliablyBetterSimulation(
  result: SampleResult | undefined, baseline: SampleResult | undefined,
): boolean {
  if (!result || !baseline || result.samples !== baseline.samples || result.samples < 8) return false;
  // Rewards lie in [-1, 1]. Without paired variance samples, use a shrinking
  // conservative margin rather than trusting the largest small-sample mean.
  const requiredMargin = Math.max(0.18, 0.8 / Math.sqrt(result.samples));
  return result.meanReward - baseline.meanReward >= requiredMargin;
}

/** Publicly provable interception of a reported single: the weaker card can be
 * overtaken, while no unseen single can beat the proposed card. No hidden hands. */
function blocksReportedSingle(
  play: CardPattern, weaker: CardPattern, hand: Card[], level: number,
  context?: AiDecisionContext,
): boolean {
  if (play.type !== PatternType.Single || weaker.type !== PatternType.Single || !context
    || !context.players.some(p => p.relation === 'opponent' && p.finishRank === null && p.cardCount === 1)) return false;
  const memory = buildPublicKnowledge(hand, context);
  if (!memory) return false;
  return memory.unseen.some(card => effectiveRank(card.rank, level) > effectiveRank(weaker.rank, level))
    && memory.unseen.every(card => effectiveRank(card.rank, level) <= effectiveRank(play.rank, level));
}

/** Enforced for both LLM replies and local fallback; explanations alone cannot
 * authorize overtaking the partner or spending a stronger equivalent group. */
export function enforceTeamStrategy(
  proposed: CardPattern | null, candidates: CardPattern[], hand: Card[],
  last: CardPattern | null, free: boolean, level: number,
  context?: AiDecisionContext, analysis?: DecisionAnalysis,
): CardPattern | null {
  const finish = candidates.find(play => play.cards.length === hand.length);
  if (finish) return finish;
  if (!proposed) {
    return null;
  }
  const continuation = analysis?.candidates[analysisKey(proposed)]?.continuation;
  if (!free && context && isBombPattern(proposed) && continuation?.exact && continuation.extraTurns >= 2
    && !context.players.some(player => player.finishRank !== null
      || (player.relation !== 'self' && player.cardCount <= 2))
    && opponentControlStreak(context) < 2
    && !materiallyBetterSimulation(proposed, null, analysis)) return null;
  const reportAdjusted = enforceNextPlayerReport(proposed, candidates, level, context);
  if (!reportAdjusted) return null;
  // Reported-count interception is a strong prior, not a legality rule.
  // A paired team-outcome comparison can justify retaining a smaller control.
  if (!materiallyBetterSimulation(proposed, reportAdjusted, analysis)) proposed = reportAdjusted;
  const partnerLed = !free && last && context
    && context.lastPlayPlayerIndex === context.partnerSeatIndex;
  if (partnerLed && last) {
    if (!blocksReportedSingle(proposed, last, hand, level, context)
      && !materiallyBetterSimulation(proposed, null, analysis)
      && !productivePartnerTakeover(proposed, hand, generateLegalPlays(hand, level), last, level, context)) return null;
  }
  const alternatives = candidates.filter(play => play.cards.length === proposed.cards.length
    && (play.type === proposed.type || (isBombPattern(play) && isBombPattern(proposed)))
    && (canBeat(proposed, play, level)
      || (play.type === PatternType.TriplePair && proposed.type === PatternType.TriplePair
        && play.rank === proposed.rank && play !== proposed))
    && (free || canBeat(play, last, level)));
  const ordered = orderCandidates([...alternatives, proposed], hand, level, free, context, analysis);
  for (const lower of ordered) {
    if (lower === proposed) break;
    const lowerTurns = analysis?.candidates[analysisKey(lower)]?.remainingTurns;
    const proposedTurns = analysis?.candidates[analysisKey(proposed)]?.remainingTurns;
    if (lowerTurns && proposedTurns && lowerTurns.turns > proposedTurns.turns) continue;
    if (materiallyBetterSimulation(proposed, lower, analysis)
      || blocksReportedSingle(proposed, lower, hand, level, context)) continue;
    // Do not weaken an interception of the partner's trick back into a pass.
    if (partnerLed && last && !blocksReportedSingle(lower, last, hand, level, context)
      && !materiallyBetterSimulation(lower, null, analysis)
      && !productivePartnerTakeover(lower, hand, generateLegalPlays(hand, level), last, level, context)) continue;
    const adjusted = enforceNextPlayerReport(lower, candidates, level, context);
    return materiallyBetterSimulation(lower, adjusted, analysis) ? lower : adjusted;
  }
  return proposed;
}

/** One final comparison for both model replies and fallback, including PASS.
 * Only compare complete paired samples; an unmeasured action keeps its prior.
 * Compare the actual guarded action, so a later preference cannot undo evidence. */
export function finalizeAiDecision(
  proposed: CardPattern | null, candidates: CardPattern[], hand: Card[],
  last: CardPattern | null, free: boolean, level: number,
  context?: AiDecisionContext, analysis?: DecisionAnalysis, ruleFallback?: CardPattern | null,
): CardPattern | null {
  const guard = (play: CardPattern | null) => enforceTeamStrategy(
    play, candidates, hand, last, free, level, context, analysis,
  );
  let selected = guard(proposed);
  // A model PASS without rollout evidence still needs to respect public tempo.
  // Prefer an intact ordinary response with a real group left to lead; spend
  // bombs only through the local defence policy or a last reported-single stop.
  const leader = context?.players.find(player => player.seatIndex === context.lastPlayPlayerIndex);
  if (!selected && !free && context && last && !analysis?.passSimulation
    && leader?.relation === 'opponent' && leader.finishRank === null) {
    const repeated = opponentControlStreak(context) >= 2;
    const urgent = leader.cardCount <= 2;
    const partnerHead = context.players.some(player => player.relation === 'partner' && player.finishRank === 1);
    if (repeated || urgent || (partnerHead && leader.cardCount <= 5)) {
      const allPlays = generateLegalPlays(hand, level);
      const counts = getRankCounts(hand);
      const ordinary = candidates.filter(play => {
        const continuation = analysis?.candidates[analysisKey(play)]?.continuation;
        // Rank groups are not the whole-hand plan: splitting a pair can leave
        // a straight/full house intact. Allow a measured, bounded cost under
        // immediate pressure, while retaining the normal conservation filter.
        const boundedSplit = urgent && continuation?.exact && continuation.extraTurns <= 2;
        return !isBombPattern(play)
          && play.cards.every(card => !isWildCard(card, level)
            && (boundedSplit || (counts.get(card.rank)?.length || 0)
              === play.cards.filter(c => c.rank === card.rank).length))
          && allPlays.some(group => group.cards.length >= 3
            && group.cards.every(card => !play.cards.some(used => used.id === card.id)));
      });
      const fallback = ruleFallback === undefined ? findBestPlay(hand, last, free, level, context, allPlays) : ruleFallback;
      let response = ordinary.length ? orderCandidates(ordinary, hand, level, false, context, analysis, allPlays)[0] : null;
      if (!response && (urgent || partnerHead)) response = fallback;
      if (!response && leader.cardCount === 1 && passPosition(context).closesTrick) {
        response = [...candidates].sort((a, b) => canBeat(a, b, level) ? 1 : canBeat(b, a, level) ? -1 : 0)[0] || null;
      }
      if (response && candidates.some(play => analysisKey(play) === analysisKey(response))) selected = guard(response);
    }
  }
  if (selected?.cards.length === hand.length || !analysis) return selected;
  const resultOf = (play: CardPattern | null) => play
    ? analysis.candidates[analysisKey(play)]?.simulation : analysis.passSimulation;
  // Compare the outcomes of actual guarded actions, not their pre-guard scores.
  // Keep the original baseline fixed: several marginal gains cannot chain into
  // an override, and a corrected action cannot hide a better later alternative.
  const baseline = resultOf(selected);
  const alternatives: Array<CardPattern | null> = [...candidates];
  if (!free) alternatives.push(null);
  for (const alternative of alternatives) {
    if (!reliablyBetterSimulation(resultOf(alternative), baseline)) continue;
    const guarded = guard(alternative);
    const result = resultOf(guarded);
    if (reliablyBetterSimulation(result, baseline)
      && (!resultOf(selected) || result!.meanReward > resultOf(selected)!.meanReward)) selected = guarded;
  }
  return selected;
}

export async function findSmartPlay(
  hand: Card[],
  lastPattern: CardPattern | null,
  isFreePlay: boolean,
  currentLevel: number,
  context?: AiDecisionContext,
  selection?: AiModelSelection,
): Promise<CardPattern | null> {
  const allPlays = generateLegalPlays(hand, currentLevel);
  const ruleResult = findBestPlay(hand, lastPattern, isFreePlay, currentLevel, context, allPlays);
  let legalPlays = allPlays;
  if (!isFreePlay && lastPattern) {
    legalPlays = legalPlays.filter(play => canBeat(play, lastPattern, currentLevel));
  }
  legalPlays = dedupeStrategicPlays(legalPlays);
  // Skip strategic analysis only when there is genuinely no choice. During a
  // follow, PASS is also legal and even one playable bomb is a real decision.
  if (isForcedAiDecision(legalPlays.length, isFreePlay)) {
    return enforceTeamStrategy(
      ruleResult, legalPlays, hand, lastPattern, isFreePlay, currentLevel, context,
    );
  }
  if (!shouldUseLlmForDecision(
    hand, legalPlays, lastPattern, isFreePlay, currentLevel, context,
  )) {
    return enforceTeamStrategy(
      ruleResult, legalPlays, hand, lastPattern, isFreePlay, currentLevel, context,
    );
  }
  // The hint system keeps every physical action. The model sees every distinct
  // declared strategy, with equivalent deck-copy/suit choices compressed.
  const completeLegalPlays = legalPlays;
  const compressed = limitModelCandidates(compressCandidatesForModel(
    orderCandidates(legalPlays, hand, currentLevel, isFreePlay, context, undefined, allPlays),
    currentLevel,
  ));
  legalPlays = retainNextPlayerReportMaximum(
    compressed.plays, completeLegalPlays, currentLevel, context,
  );
  let equivalentCounts = legalPlays.map(play => {
    const index = compressed.plays.indexOf(play);
    return index >= 0 ? compressed.equivalentCounts[index] : 1;
  });
  const equivalentCountByPlay = new Map(legalPlays.map((play, index) => [play, equivalentCounts[index]]));
  if (ruleResult && !legalPlays.some(play => analysisKey(play) === analysisKey(ruleResult))) {
    const replacement = legalPlays.findIndex(play => play.type === ruleResult.type && play.rank === ruleResult.rank);
    if (replacement >= 0) legalPlays[replacement] = ruleResult;
    else legalPlays.push(ruleResult);
    equivalentCountByPlay.set(ruleResult, 1);
  }
  const handCombinations = isFreePlay ? compressed : limitModelCandidates(compressCandidatesForModel(
    orderCandidates(dedupeStrategicPlays(allPlays), hand, currentLevel, true, context, undefined, allPlays),
    currentLevel,
  ));
  const analysis = await analyzeDecision(
    hand, allPlays, legalPlays, isFreePlay ? null : lastPattern,
    currentLevel, context, findBestPlay, { generateReplies: generateLegalPlays },
  );
  legalPlays = orderCandidates(legalPlays, hand, currentLevel, isFreePlay, context, analysis, allPlays);
  equivalentCounts = legalPlays.map(play => equivalentCountByPlay.get(play) || 1);
  const fallbackResult = (isFreePlay || ruleResult) ? legalPlays[0] || ruleResult : null;

  try {
    const llmResult = await llmFindBestPlay(
      hand,
      legalPlays,
      lastPattern,
      isFreePlay,
      currentLevel,
      context,
      selection,
      analysis,
      equivalentCounts,
      handCombinations.plays,
      handCombinations.equivalentCounts,
    );
    // undefined means the model was unavailable/invalid; null is an intentional pass.
    if (llmResult !== undefined) return finalizeAiDecision(
      llmResult, legalPlays, hand, lastPattern, isFreePlay, currentLevel, context, analysis, ruleResult,
    );
  } catch {}

  return finalizeAiDecision(
    fallbackResult, legalPlays, hand, lastPattern, isFreePlay, currentLevel, context, analysis, ruleResult,
  );
}

export function isForcedAiDecision(playableCount: number, isFreePlay: boolean): boolean {
  return playableCount === 0 || (isFreePlay && playableCount === 1);
}

/** Every non-forced decision deserves analysis, including one response vs PASS. */
export function shouldUseLlmForDecision(
  _hand: Card[], legalPlays: CardPattern[], _lastPattern: CardPattern | null,
  isFreePlay: boolean, _currentLevel: number, _context?: AiDecisionContext,
): boolean {
  return !isForcedAiDecision(legalPlays.length, isFreePlay);
}
