import assert from 'node:assert/strict';
import test from 'node:test';
import { Card, CardPattern, PatternType, Rank, Suit } from '../../../shared/types';
import { createDeck } from './card';
import { findBestPlay, generateLegalPlays, findSmartPlay, enforceTeamStrategy, finalizeAiDecision } from './ai';
import type { DecisionAnalysis } from './aiAnalysis';
import {
  analyzeDecision, analyzeEndgameRoutes, analysisKey, buildPublicKnowledge, buildTeamRoutes, buildTeamPlan, createTurnEstimator,
  rollout, sampleHiddenHands, sampleHiddenHandsWeighted, enumerateHiddenHands, publicControlEvidence,
  behaviorConsistencyWeight, inferSeatBeliefs,
} from './aiAnalysis';
import { llmFindBestPlay } from './llmAi';
import type { AiDecisionContext, AiRecentAction } from './llmAi';
import { GameRoom } from '../services/GameRoom';
import { getAiTelemetrySnapshot, resetAiTelemetry } from './aiTelemetry';

function contextFor(hands: Card[][]): AiDecisionContext {
  const held = new Set(hands.flat().map(card => card.id));
  const discarded = createDeck().filter(card => !held.has(card.id));
  const actionHistory: AiRecentAction[] = [];
  let offset = 0;
  for (let seat = 0; seat < 4; seat++) {
    for (const card of discarded.slice(offset, offset + 27 - hands[seat].length)) {
      actionHistory.push({ seatIndex: seat, action: 'play', pattern: {
        cards: [card], rank: card.rank, type: PatternType.Single, length: 1,
      } });
    }
    offset += 27 - hands[seat].length;
  }
  return {
    selfSeatIndex: 0, partnerSeatIndex: 2, lastPlayPlayerIndex: -1,
    roundNumber: 1, teamLevels: [2, 2], leadingTeam: 0, passCount: 0,
    actionHistory, recentActions: actionHistory.slice(-12),
    players: hands.map((hand, seat) => ({
      seatIndex: seat, cardCount: hand.length, finishRank: null,
      relation: seat === 0 ? 'self' : seat === 2 ? 'partner' : 'opponent',
    })),
  };
}

function rankedHand(ranks: Rank[]): Card[] {
  return ranks.map((rank, id) => ({ id, rank, suit: [Suit.Spade, Suit.Heart, Suit.Club, Suit.Diamond][id % 4] }));
}

test('small hidden deal enumeration covers every allocation and respects cap', () => {
  const deck = createDeck();
  const hands = [[deck[0]], [deck[1]], [deck[2]], [deck[3]]];
  const context = contextFor(hands);
  const knowledge = buildPublicKnowledge(hands[0], context)!;
  const deals = enumerateHiddenHands(hands[0], context, knowledge)!;
  assert.equal(deals.length, 6);
  assert.equal(new Set(deals.map(d => d.map(h => h.map(c => c.id).join(',')).join('|'))).size, 6);
  for (const deal of deals) {
    assert.deepEqual(deal[0], hands[0]);
    assert.equal(new Set(deal.flat().map(c => c.id)).size, 4);
  }
  assert.equal(enumerateHiddenHands(hands[0], context, knowledge, 5), null);
});

test('weighted hidden sampling stays legal and treats passes as soft evidence', () => {
  const deck = createDeck();
  const hands = [[deck[0]], [deck[1]], [deck[2]], [deck[3]]];
  const context = contextFor(hands);
  context.actionHistory!.push({ seatIndex: 1, action: 'pass' });
  const knowledge = buildPublicKnowledge(hands[0], context)!;
  const sampled = sampleHiddenHandsWeighted(hands[0], context, knowledge, Rank.Two, () => 0.5)!;
  assert.deepEqual(sampled.map(cards => cards.length), [1, 1, 1, 1]);
  assert.equal(new Set(sampled.flat().map(card => card.id)).size, 4);
});

test('public control proof accounts for bombs and wildcard-assisted bombs', () => {
  const deck = createDeck();
  const self = [deck.find(card => card.rank === Rank.BigJoker)!];
  const context = contextFor([self, [], [], []]);
  const play = generateLegalPlays(self, Rank.Two)[0];
  assert.equal(publicControlEvidence(play, self, Rank.Two, context)?.unbeatable, true);

  const lateHands = [[deck[1]], [deck[2]], [deck[3]], [deck[4]]];
  const lateContext = contextFor(lateHands);
  const low = generateLegalPlays(lateHands[0], Rank.Two)[0];
  assert.equal(publicControlEvidence(low, lateHands[0], Rank.Two, lateContext)?.unbeatable, false);
});

test('final policy rejects overtaking partner and prioritizes a direct finish', () => {
  const hand = rankedHand([14, 16, 3]);
  const candidates = generateLegalPlays(hand, 2);
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 2;
  const last: CardPattern = { type: PatternType.Single, rank: Rank.King, length: 1,
    cards: [{ id: 99, suit: Suit.Spade, rank: Rank.King }] };
  const large = candidates.find(p => p.rank === Rank.BigJoker)!;
  assert.equal(enforceTeamStrategy(large, candidates, hand, last, false, 2, context), null);
  const finishHand = [hand[1]];
  const finishPlays = generateLegalPlays(finishHand, 2);
  assert.equal(enforceTeamStrategy(null, finishPlays, finishHand, last, false, 2, context)?.rank, Rank.BigJoker);
});

test('final policy chooses smaller equivalent pairs but does not break a bomb', () => {
  const hand = rankedHand([3, 3, 13, 13, 7]);
  const plays = generateLegalPlays(hand, 2);
  const high = plays.find(p => p.type === PatternType.Pair && p.rank === Rank.King)!;
  assert.equal(enforceTeamStrategy(high, plays, hand, null, true, 2)?.rank, Rank.Three);
  const bombHand = rankedHand([3, 3, 3, 3, 13, 13, 7]);
  const bombPlays = generateLegalPlays(bombHand, 2);
  const intact = bombPlays.find(p => p.type === PatternType.Pair && p.rank === Rank.King)!;
  assert.equal(enforceTeamStrategy(intact, bombPlays, bombHand, null, true, 2)?.rank, Rank.King);
});

test('publicly unbeatable pair is retained on a calm lead, including model proposals', () => {
  const deck = createDeck();
  const pick = (rank: Rank, suit: Suit) => deck.find(c => c.rank === rank && c.suit === suit)!;
  const hand = [pick(Rank.Three, Suit.Spade), pick(Rank.Three, Suit.Club),
    pick(Rank.King, Suit.Spade), pick(Rank.King, Suit.Club), pick(Rank.Seven, Suit.Diamond)];
  const unseen = [Rank.Four, Rank.Five, Rank.Six, Rank.Eight, Rank.Nine, Rank.Ten, Rank.Queen]
    .flatMap(rank => [Suit.Heart, Suit.Club, Suit.Diamond].map(suit => pick(rank, suit)));
  const context = contextFor([hand, unseen.slice(0, 7), unseen.slice(7, 14), unseen.slice(14)]);
  const plays = generateLegalPlays(hand, Rank.Two);
  const kings = plays.find(play => play.type === PatternType.Pair && play.rank === Rank.King)!;
  assert.equal(publicControlEvidence(kings, hand, Rank.Two, context)?.unbeatable, true);
  assert.equal(findBestPlay(hand, null, true, Rank.Two, context)?.rank, Rank.Three);
  assert.equal(enforceTeamStrategy(kings, plays, hand, null, true, Rank.Two, context)?.rank, Rank.Three);
});

test('short hand probes with a recapture and exit, but never feeds a reported single', () => {
  const deck = createDeck();
  const pick = (rank: Rank, suit: Suit) => deck.find(c => c.rank === rank && c.suit === suit)!;
  const hand = [pick(Rank.Three, Suit.Spade), pick(Rank.BigJoker, Suit.Heart),
    pick(Rank.Eight, Suit.Spade), pick(Rank.Eight, Suit.Club)];
  const unseen = [Rank.Four, Rank.Five, Rank.Six, Rank.Nine, Rank.Ten, Rank.Queen, Rank.King]
    .flatMap(rank => [Suit.Heart, Suit.Club, Suit.Diamond].map(suit => pick(rank, suit)));
  const context = contextFor([hand, unseen.slice(0, 7), unseen.slice(7, 14), unseen.slice(14)]);
  const plays = generateLegalPlays(hand, Rank.Two);
  const probe = plays.find(p => p.type === PatternType.Single && p.rank === Rank.Three)!;
  const big = plays.find(p => p.type === PatternType.Single && p.rank === Rank.BigJoker)!;
  const route = analyzeEndgameRoutes(hand, plays, Rank.Two, context)[analysisKey(probe)];
  assert.equal(route.intent, 'probe_then_recapture');
  assert.equal(route.controlProven, true);
  assert.equal(route.recapture?.rank, Rank.BigJoker);
  assert.equal(route.exit?.type, PatternType.Pair);
  assert.equal(findBestPlay(hand, null, true, Rank.Two, context)?.rank, Rank.Three);
  assert.equal(enforceTeamStrategy(big, plays, hand, null, true, Rank.Two, context)?.rank, Rank.Three);

  const danger = contextFor([hand, unseen.slice(0, 7), unseen.slice(7, 14), unseen.slice(14, 15)]);
  assert.equal(analyzeEndgameRoutes(hand, plays, Rank.Two, danger)[analysisKey(probe)], undefined);
  assert.equal(findBestPlay(hand, null, true, Rank.Two, danger)?.type, PatternType.Pair);

  const noMemory = { ...context, actionHistory: undefined };
  const uncertain = analyzeEndgameRoutes(hand, plays, Rank.Two, noMemory)[analysisKey(probe)];
  assert.equal(uncertain.controlProven, false);
  assert.match(uncertain.caveat, /可能/);
});

test('proven control followed by a whole-hand exit takes priority in the endgame', () => {
  const deck = createDeck();
  const hand = [deck.find(c => c.rank === Rank.BigJoker)!,
    ...deck.filter(c => c.rank === Rank.Three).slice(0, 2)];
  const unseen = deck.filter(c => [Rank.Five, Rank.Seven, Rank.Nine].includes(c.rank)
    && [Suit.Spade, Suit.Club, Suit.Diamond].includes(c.suit)).slice(0, 9);
  const context = contextFor([hand, unseen.slice(0, 3), unseen.slice(3, 6), unseen.slice(6)]);
  const play = findBestPlay(hand, null, true, Rank.Two, context)!;
  assert.equal(play.rank, Rank.BigJoker);
  const plays = generateLegalPlays(hand, Rank.Two);
  const route = analyzeEndgameRoutes(hand, plays, Rank.Two, context)[analysisKey(play)];
  assert.equal(route.intent, 'control_then_finish');
  assert.equal(route.exit?.type, PatternType.Pair);
});

test('four lucky simulations do not authorize overtaking partner; substantial paired evidence can', () => {
  const hand = rankedHand([14, 7]);
  const plays = generateLegalPlays(hand, 2);
  const high = plays.find(p => p.rank === Rank.Ace)!;
  const last: CardPattern = { type: PatternType.Single, rank: Rank.King, length: 1,
    cards: [{ id: 99, suit: Suit.Spade, rank: Rank.King }] };
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 2;
  context.players.forEach(player => { if (player.relation === 'opponent') player.cardCount = 8; });
  const analysis: DecisionAnalysis = {
    handTurns: { turns: 2, exact: true },
    candidates: { [analysisKey(high)]: { remainingTurns: { turns: 1, exact: true },
      simulation: { samples: 4, meanReward: 1, winRate: 1, doubleWinRate: 1 } } },
    passSimulation: { samples: 4, meanReward: 0, winRate: 0.5, doubleWinRate: 0 },
    simulation: { samples: 4, elapsedMs: 10, status: 'sampled' },
  };
  assert.equal(enforceTeamStrategy(high, plays, hand, last, false, 2, context, analysis), null);
  analysis.candidates[analysisKey(high)].simulation!.samples = 8;
  analysis.passSimulation!.samples = 8;
  assert.equal(enforceTeamStrategy(high, plays, hand, last, false, 2, context, analysis), high);
  assert.equal(finalizeAiDecision(null, plays, hand, last, false, 2, context, analysis), high,
    'team evidence may replace model PASS even without a reported opponent');
  analysis.candidates[analysisKey(high)].simulation!.meanReward = -0.5;
  analysis.passSimulation!.meanReward = 0.5;
  context.lastPlayPlayerIndex = 1;
  assert.equal(finalizeAiDecision(high, plays, hand, last, false, 2, context, analysis), null,
    'the same comparison may replace model play with PASS');
  analysis.passSimulation!.samples = 4;
  assert.equal(finalizeAiDecision(high, plays, hand, last, false, 2, context, analysis), high,
    'unmatched samples cannot override the model');
});

test('public memory allows a necessary single interception but not overtaking an unbeatable partner', () => {
  const deck = createDeck();
  const hands = [[deck[53], deck[1]], [deck[52]], [deck[2]], [deck[3]]];
  const context = contextFor(hands);
  context.lastPlayPlayerIndex = 2;
  const plays = generateLegalPlays(hands[0], 2);
  const big = plays.find(p => p.rank === Rank.BigJoker)!;
  const last: CardPattern = { type: PatternType.Single, rank: Rank.Ace, cards: [], length: 1 };
  assert.equal(enforceTeamStrategy(big, plays, hands[0], last, false, 2, context), big);
  const unbeatable = { ...last, rank: Rank.SmallJoker };
  assert.equal(enforceTeamStrategy(big, plays, hands[0], unbeatable, false, 2, context), null);
});

test('complete public memory counts physical wildcard and pins public transfers only', () => {
  const deck = createDeck();
  const hands = [[deck[0]], [deck[1], deck[2]], [deck[3]], [deck[4]]];
  const context = contextFor(hands);
  const wildAction = context.actionHistory!.find(action => action.pattern!.cards[0].id === 13)!;
  wildAction.pattern!.substitutions = [{ ...deck[13], rank: Rank.Ace, suit: Suit.Club }];
  context.publicTransfers = [{ fromSeat: 2, toSeat: 1, card: deck[1] }];
  const memory = buildPublicKnowledge(hands[0], context)!;
  assert.equal(memory.played.length, 103);
  assert.ok(memory.played.some(card => card.id === 13 && card.rank === Rank.Two));
  assert.deepEqual(memory.unseen.map(card => card.id), [1, 2, 3, 4]);
  const sample = sampleHiddenHands(hands[0], context, memory, () => 0.5)!;
  assert.deepEqual(sample.map(cards => cards.length), [1, 2, 1, 1]);
  assert.ok(sample[1].some(card => card.id === 1));
  assert.equal(new Set(sample.flat().map(card => card.id)).size, 5);
  assert.equal(buildPublicKnowledge(hands[0], { ...context, actionHistory: undefined }), null);
  assert.equal(sampleHiddenHands(hands[0], {
    ...context, players: context.players.map(p => ({ ...p, cardCount: p.cardCount + 1 })),
  }, memory), null);
});

test('returned tribute ownership overrides earlier transfer; passes do not eliminate cards', () => {
  const deck = createDeck();
  const hands = [[deck[0]], [deck[1]], [deck[2]], [deck[3]]];
  const context = contextFor(hands);
  context.publicTransfers = [
    { fromSeat: 1, toSeat: 2, card: deck[1] },
    { fromSeat: 2, toSeat: 1, card: deck[1] },
  ];
  context.actionHistory!.push({ seatIndex: 1, action: 'pass' });
  const memory = buildPublicKnowledge(hands[0], context)!;
  assert.deepEqual(memory.knownBySeat[1], [deck[1]]);
  assert.deepEqual(memory.knownBySeat[2], []);
});

test('exact hand decomposition finds two full houses instead of greedy extra moves', () => {
  const hand = rankedHand([3, 3, 3, 4, 4, 4, 5, 5, 6, 6]);
  const plays = generateLegalPlays(hand, 2);
  const estimator = createTurnEstimator(hand, plays, performance.now() + 1000);
  assert.deepEqual(estimator.whole(), { turns: 2, exact: true });
  const fullHouse = plays.find(play => play.type === PatternType.TriplePair && play.rank === Rank.Three
    && play.cards.filter(card => card.rank === Rank.Five).length === 2)!;
  assert.deepEqual(estimator.after(fullHouse), { turns: 1, exact: true });
  const bounded = createTurnEstimator(hand, plays, 0);
  assert.equal(bounded.whole().exact, false);
  assert.ok(bounded.whole().turns >= 2 && bounded.whole().turns <= hand.length);
  assert.deepEqual(createTurnEstimator([], [], 0).whole(), { turns: 0, exact: true });
});

test('decomposition can use wildcard combinations', () => {
  const hand = rankedHand([2, 3, 3, 4, 4, 4]);
  hand[0].suit = Suit.Heart;
  const estimator = createTurnEstimator(hand, generateLegalPlays(hand, 2), performance.now() + 1000);
  assert.deepEqual(estimator.whole(), { turns: 1, exact: true });
});

test('rollout applies catch-wind and stops when one team finishes first and second', () => {
  const deck = createDeck();
  const hands = [[deck[1]], [deck[2]], [], [deck[3]]];
  const context = contextFor(hands);
  context.players[2].finishRank = 1;
  context.lastPlayPlayerIndex = 2;
  context.passCount = 1;
  const last: CardPattern = { type: PatternType.Single, rank: Rank.BigJoker,
    cards: [deck[53]], length: 1 };
  const originalHistory = JSON.stringify(context.actionHistory);
  const visits: Array<[number, boolean]> = [];
  const result = rollout(hands, null, last, 2, context, (hand, trick, free, level, state) => {
    visits.push([state.selfSeatIndex, free]);
    assert.ok(buildPublicKnowledge(hand, state), 'memory remains consistent from each seat');
    assert.deepEqual(state.actionHistory!.slice(0, context.actionHistory!.length), context.actionHistory);
    assert.equal(state.actionHistory!.at(-1)?.action, 'pass');
    assert.equal(state.actionHistory!.length, context.actionHistory!.length + visits.length);
    assert.equal(state.recentActions.at(-1)?.action, 'pass');
    return findBestPlay(hand, trick, free, level, state);
  }, performance.now() + 1000);
  assert.deepEqual(visits, [[1, false], [0, true]]);
  assert.deepEqual(result, { reward: 1, win: true, doubleWin: true });
  assert.equal(hands[0].length, 1, 'simulation must not mutate the caller hand');
  assert.equal(JSON.stringify(context.actionHistory), originalHistory, 'simulation must not mutate live history');
});

test('endgame uses balanced complete samples and labels exhausted/incomplete runs', async () => {
  const deck = createDeck();
  const hands = [[deck[0], deck[1]], [deck[2], deck[3]], [deck[4], deck[5]], [deck[6], deck[7]]];
  const context = contextFor(hands);
  const plays = generateLegalPlays(hands[0], 2);
  const analysis = await analyzeDecision(hands[0], plays, plays, null, 2, context, findBestPlay,
    { budgetMs: 2000, maxSamples: 4, random: () => 0.5, generateReplies: generateLegalPlays });
  assert.equal(analysis.simulation.samples, 4);
  for (const play of plays) {
    const result = analysis.candidates[analysisKey(play)].simulation!;
    assert.equal(result.samples, 4);
    assert.ok(result.winRate >= 0 && result.winRate <= 1);
  }
  const expired = await analyzeDecision(hands[0], plays, plays, null, 2, context, findBestPlay,
    { budgetMs: 0 });
  assert.equal(expired.simulation.samples, 0);
  const missing = await analyzeDecision(hands[0], plays, plays, null, 2,
    { ...context, actionHistory: undefined }, findBestPlay);
  assert.equal(missing.simulation.status, 'incomplete_public_history');
});

test('LLM input contains complete public memory and local analysis, not sampled hands', async () => {
  resetAiTelemetry();
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-only';
  const deck = createDeck();
  const hands = [[deck[0]], [deck[1]], [deck[2]], [deck[3]]];
  const context = contextFor(hands);
  const plays = generateLegalPlays(hands[0], 2);
  const analysis = await analyzeDecision(hands[0], plays, plays, null, 2, context, findBestPlay,
    { budgetMs: 0 });
  let input: any;
  let requestBody: any;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    requestBody = body;
    input = JSON.parse(body.messages[1].content.split('\n')[1]);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action_id":0}' } }] }) } as Response;
  }) as typeof fetch;
  try {
    await llmFindBestPlay(hands[0], plays, null, true, 2, context,
      { provider: 'deepseek', model: 'deepseek-v4-flash' }, analysis);
    assert.equal(input.recent_action_history.length, 12);
    assert.equal(input.public_memory.played_cards, undefined);
    assert.ok(input.public_memory.unseen_cards);
    assert.equal(input.played_by_seat.length, 4);
    assert.ok(input.played_by_seat.every((player: any) => player.cards.length > 0));
    assert.deepEqual(input.local_analysis.hand_turns, { turns: 1, exact: true });
    assert.equal(input.team_plan.goal, 'finish_self');
    assert.equal(input.legal_action_member_schema[10], 'analysis');
    assert.equal(input.legal_actions[0][1][0][10].remainingTurns.turns, 0);
    assert.equal(input.candidate_coverage.model_actions, plays.length);
    assert.equal(input.candidate_coverage.represented_equivalent_actions, plays.length);
    assert.equal(input.hand_combinations.same_as_legal_actions, true);
    assert.equal(input.legal_actions[0][1][0][4], 1);
    assert.equal(typeof input.public_inference.unseen_controls, 'string');
    assert.ok(input.public_memory.publicly_known_cards.every((p: any) => p.cards === ''));
    assert.equal(input.sampled_hands, undefined);
    assert.equal(requestBody.max_tokens, 512);
    assert.deepEqual(requestBody.thinking, { type: 'enabled' });
    assert.equal(requestBody.reasoning_effort, 'low');
    assert.equal(requestBody.temperature, undefined);
    assert.deepEqual(requestBody.response_format, { type: 'json_object' });
    assert.ok(requestBody.messages[0].content.length < 2500);
    const telemetry = getAiTelemetrySnapshot();
    assert.equal(telemetry.modelCalls, 1);
    assert.equal(telemetry.modelOutcomes.success, 1);
    assert.ok(telemetry.promptCharacters > 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

test('unavailable model falls back to a legal analyzed move', async () => {
  const hand = rankedHand([3, 3, 3, 4, 4, 4, 5, 5, 6, 6]);
  const result = await findSmartPlay(hand, null, true, 2, undefined, { provider: 'local', model: '' });
  assert.ok(result);
  assert.equal(result.type, PatternType.TriplePair, 'prefer two full houses to three or more moves');
  assert.ok(generateLegalPlays(hand, 2).some(play => analysisKey(play) === analysisKey(result)));
});

test('room AI context derives counts from public history and clears memory next round', () => {
  const room = new GameRoom('analysis-test', 'p0');
  for (let seat = 0; seat < 4; seat++) room.addPlayer(`p${seat}`, `P${seat}`, 2, null);
  const deck = createDeck();
  const hands = [[deck[0]], [deck[1]], [deck[2]], [deck[3]]];
  const context = contextFor(hands);
  const internals = room as unknown as {
    publicActionHistory: AiRecentAction[];
    getAiDecisionContext(seat: number): AiDecisionContext;
  };
  internals.publicActionHistory = context.actionHistory!;
  // Deliberately make private hands disagree: they must not be consulted.
  room.hands.set('p1', deck.slice(0, 20));
  assert.deepEqual(internals.getAiDecisionContext(0).players.map(p => p.cardCount), [1, 1, 1, 1]);
  assert.equal(internals.getAiDecisionContext(0).actionHistory!.length, 104);
  try {
    room.startGame();
    const next = internals.getAiDecisionContext(0);
    assert.deepEqual(next.actionHistory, []);
    assert.deepEqual(next.players.map(p => p.cardCount), [27, 27, 27, 27]);
  } finally {
    if (room.turnTimer) clearTimeout(room.turnTimer);
  }
});


test('unified decision lets paired team outcomes override reported-maximum preference', () => {
  const hand = rankedHand([Rank.Ace, Rank.BigJoker, Rank.Seven]);
  const plays = generateLegalPlays(hand, Rank.Two).filter(p => p.type === PatternType.Single
    && [Rank.Ace, Rank.BigJoker].includes(p.rank));
  const ace = plays.find(p => p.rank === Rank.Ace)!;
  const joker = plays.find(p => p.rank === Rank.BigJoker)!;
  const last: CardPattern = { type: PatternType.Single, rank: Rank.King, length: 1,
    cards: [{ id: 99, rank: Rank.King, suit: Suit.Spade }] };
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 3;
  context.players[1].cardCount = 1;
  const sample = (meanReward: number) => ({ samples: 16, meanReward, winRate: 0.5, doubleWinRate: 0 });
  const analysis: DecisionAnalysis = {
    handTurns: { turns: 3, exact: true },
    candidates: {
      [analysisKey(ace)]: { remainingTurns: { turns: 2, exact: true }, simulation: sample(0.8) },
      [analysisKey(joker)]: { remainingTurns: { turns: 2, exact: true }, simulation: sample(-0.4) },
    }, passSimulation: sample(-0.8), simulation: { samples: 16, elapsedMs: 0, status: 'sampled' },
  };
  assert.equal(finalizeAiDecision(joker, plays, hand, last, false, Rank.Two, context, analysis), ace);
  analysis.candidates[analysisKey(ace)].simulation!.samples = 2;
  assert.equal(finalizeAiDecision(ace, plays, hand, last, false, Rank.Two, context, analysis), joker,
    'insufficient evidence keeps reported-maximum protection');
});


test('endgame response branches expose an opponent finishing after a probe', () => {
  const deck = createDeck();
  const take = (rank: Rank, count = 1) => deck.filter(c => c.rank === rank).slice(0, count);
  const hands = [[...take(Rank.Three), ...take(Rank.King, 2)], take(Rank.Four), take(Rank.Five), take(Rank.Six)];
  const context = contextFor(hands);
  const probe = generateLegalPlays(hands[0], Rank.Two).find(p => p.rank === Rank.Three)!;
  const passive = (hand: Card[], last: CardPattern | null, free: boolean, level: number) =>
    free ? generateLegalPlays(hand, level).sort((a, b) => b.cards.length - a.cards.length)[0] : null;
  const deadline = performance.now() + 1000;
  const baseline = rollout(hands, probe, null, Rank.Two, context, passive, deadline)!;
  const control = rollout(hands, probe, null, Rank.Two, context, passive, deadline,
    { mode: 'control', generate: generateLegalPlays })!;
  const hold = rollout(hands, probe, null, Rank.Two, context, passive, deadline,
    { mode: 'hold', generate: generateLegalPlays })!;
  assert.equal(baseline.win, true);
  assert.equal(control.win, false, 'active reply finishes before the probing player can recapture');
  assert.deepEqual(hold, control, 'even a conservative opponent takes an immediate finish');
});


test('team routes compare feeding mixed singles, seat interception, takeover and holding', () => {
  const deck = createDeck();
  const take = (rank: Rank, n = 1) => deck.filter(c => c.rank === rank).slice(0, n);
  const hands = [[...take(Rank.Three, 2), ...take(Rank.Ace)], take(Rank.Four),
    [...take(Rank.Five), ...take(Rank.Seven)], take(Rank.Six)];
  const context = contextFor(hands);
  context.publicTransfers = hands[2].map(card => ({ fromSeat: 1, toSeat: 2, card }));
  const plays = generateLegalPlays(hands[0], Rank.Two);
  const leadRoutes = buildTeamRoutes(hands[0], plays, plays, null, Rank.Two, context, {}, generateLegalPlays);
  const feeds = leadRoutes.filter(route => route.goal === 'feed_partner');
  assert.equal(feeds.length, 1, 'known mixed singles must not be treated as a pair');
  assert.equal(plays.find(play => analysisKey(play) === feeds[0].actionKey)?.type, PatternType.Single);
  assert.deepEqual(feeds[0].interceptSeats, [1], 'the opponent before the partner can finish first');
  assert.ok(leadRoutes.some(route => route.goal === 'finish_self'));
  const last = generateLegalPlays(take(Rank.King), Rank.Two)[0];
  const replies = plays.filter(play => play.type === PatternType.Single && play.rank === Rank.Ace);
  const followRoutes = buildTeamRoutes(hands[0], plays, replies, last, Rank.Two, context, {}, generateLegalPlays);
  assert.ok(followRoutes.some(route => route.goal === 'hold_control' && route.actionKey === null));
  const takeover = followRoutes.find(route => route.goal === 'takeover_change')!;
  assert.equal(takeover.actionKey, analysisKey(replies[0]));
  assert.equal(takeover.nextLead?.rank, Rank.Three, 'taking control retains a real disjoint feed');
  const unknown = buildTeamRoutes(hands[0], plays, plays, null, Rank.Two,
    { ...context, publicTransfers: [] }, {}, generateLegalPlays);
  assert.equal(unknown.filter(route => route.goal === 'feed_partner').length, 2,
    'unknown two-card partner gets single and pair alternatives');
});


test('behavior inference distinguishes cheap passes, protected groups and teammate passes', () => {
  const deck = createDeck();
  const take = (rank: Rank, n = 1) => deck.filter(c => c.rank === rank).slice(0, n);
  const hands = [take(Rank.Three), take(Rank.Four), [...take(Rank.Ten), ...take(Rank.Five)], take(Rank.Six)];
  const context = contextFor(hands);
  const lead = generateLegalPlays(take(Rank.Seven), Rank.Two)[0];
  context.actionHistory = [{ seatIndex: 1, action: 'play', pattern: lead }, { seatIndex: 2, action: 'pass' }];
  const loose = behaviorConsistencyWeight(hands, context, Rank.Two);
  const protectedHands = hands.map(cards => [...cards]);
  protectedHands[2] = take(Rank.Ten, 2);
  assert.ok(loose < behaviorConsistencyWeight(protectedHands, context, Rank.Two),
    'a pass is less surprising when beating would split a pair');
  context.actionHistory[0].seatIndex = 0;
  assert.equal(behaviorConsistencyWeight(hands, context, Rank.Two), 1, 'passing partner is not negative evidence');
  context.actionHistory = [{ seatIndex: 2, action: 'play', pattern: generateLegalPlays(take(Rank.Ten).map(c => ({ ...c, id: 999 })), Rank.Two)[0] }];
  assert.ok(behaviorConsistencyWeight(hands, context, Rank.Two) < 1, 'unnecessary group splitting is soft evidence');
  assert.ok(loose > 0, 'a pass never rules a holding out');
});

test('seat beliefs respect public transfers and distinguish two singles from a pair', () => {
  const deck = createDeck();
  const take = (rank: Rank, n = 1) => deck.filter(c => c.rank === rank).slice(0, n);
  for (const partner of [[...take(Rank.Five), ...take(Rank.Seven)], take(Rank.Five, 2)]) {
    const hands = [take(Rank.Three), take(Rank.Four), partner, take(Rank.Six)];
    const context = contextFor(hands);
    context.publicTransfers = partner.map(card => ({ fromSeat: 1, toSeat: 2, card }));
    const beliefs = inferSeatBeliefs(hands[0], context, Rank.Two, performance.now() + 1000, () => 0.5);
    const belief = beliefs.find(item => item.seat === 2)!;
    assert.equal(belief.samples, 16);
    assert.equal(belief.pairProbability, partner[0].rank === partner[1].rank ? 1 : 0);
    assert.ok(!beliefs.some(item => item.seat === 0), 'no redundant inference of our own known hand');
  }
});


test('bomb continuation exposes the lost straight and guards calm waste, but allows urgent defence', async () => {
  const hand = rankedHand([3, 3, 3, 3, 13, 13, 7, 7, 4, 5, 6]);
  const plays = generateLegalPlays(hand, Rank.Two);
  const bomb = plays.find(play => play.type === PatternType.Bomb4)!;
  const analysis = await analyzeDecision(hand, plays, [bomb], null, Rank.Two, undefined, findBestPlay,
    { budgetMs: 200 });
  assert.equal(analysis.handTurns.turns, 3);
  assert.equal(analysis.candidates[analysisKey(bomb)].remainingTurns.turns, 5);
  assert.deepEqual(analysis.candidates[analysisKey(bomb)].continuation,
    { extraTurns: 3, exact: true, largestRemainingGroup: 2 });
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 1;
  context.players.forEach(p => { if (p.relation !== 'self') p.cardCount = 8; });
  const last = generateLegalPlays(rankedHand([Rank.BigJoker]), Rank.Two)[0];
  assert.equal(enforceTeamStrategy(bomb, [bomb], hand, last, false, Rank.Two, context, analysis), null);
  context.players[1].cardCount = 2;
  assert.equal(enforceTeamStrategy(bomb, [bomb], hand, last, false, Rank.Two, context, analysis), bomb);
});


test('partner head changes the objective and unmeasured PASS cannot ignore a local interception', () => {
  const hand = rankedHand([Rank.BigJoker, Rank.Three, Rank.Four]);
  const plays = generateLegalPlays(hand, Rank.Two);
  const joker = plays.find(play => play.rank === Rank.BigJoker)!;
  const last = generateLegalPlays(rankedHand([Rank.King]), Rank.Two)[0];
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 1;
  context.players[1].cardCount = 4;
  context.players[2].finishRank = 1;
  context.players[3].cardCount = 8;
  assert.equal(buildTeamPlan(hand, plays, context).goal, 'finish_self');
  assert.equal(finalizeAiDecision(null, [joker], hand, last, false, Rank.Two, context, undefined, joker), joker);
  assert.equal(finalizeAiDecision(null, [joker], hand, last, false, Rank.Two, context, undefined, null), null,
    'no interception is invented when local policy also passes');
  context.players[2].finishRank = null;
  assert.equal(finalizeAiDecision(null, [joker], hand, last, false, Rank.Two, context, undefined, joker), null,
    'normal midgame model PASS is preserved');
  context.players[2].finishRank = 1;
  context.players[1].finishRank = 2;
  context.players[1].cardCount = 0;
  assert.match(buildTeamPlan(hand, plays, context).reason, /争三游/);
  assert.equal(finalizeAiDecision(null, [joker], hand, last, false, Rank.Two, context, undefined, joker), null,
    'cannot pretend an already finished opponent is still about to finish');
});


test('repeated enemy leads spend a loose joker with a group exit; teammate and calm passes remain', () => {
  const hand = rankedHand([Rank.BigJoker, 3, 3, 3, 5]);
  const joker = generateLegalPlays(hand, 2).find(p => p.rank === Rank.BigJoker)!;
  const last = generateLegalPlays(rankedHand([Rank.Two]), 2)[0];
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 1;
  context.players.forEach(p => { if (p.relation !== 'self') p.cardCount = 12; });
  context.actionHistory = [{ seatIndex: 1, action: 'play', pattern: last },
    { seatIndex: 0, action: 'pass' }, { seatIndex: 1, action: 'play', pattern: last }];
  assert.equal(finalizeAiDecision(null, [joker], hand, last, false, 2, context, undefined, null), joker);
  context.actionHistory = context.actionHistory.slice(-1);
  assert.equal(finalizeAiDecision(null, [joker], hand, last, false, 2, context, undefined, null), null);
  context.lastPlayPlayerIndex = 2;
  assert.equal(finalizeAiDecision(null, [joker], hand, last, false, 2, context, undefined, joker), null);
});

test('last response to a reported single cannot save a bomb until after the opponent finishes', () => {
  const hand = rankedHand([4, 4, 4, 4, 6, 7]);
  const bomb = generateLegalPlays(hand, 2).find(p => p.type === PatternType.Bomb4)!;
  const last = generateLegalPlays(rankedHand([Rank.King, Rank.King]), 2).find(p => p.type === PatternType.Pair)!;
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 1;
  context.passCount = 2;
  context.players.forEach(p => { if (p.relation !== 'self') p.cardCount = p.seatIndex === 1 ? 1 : 8; });
  assert.equal(finalizeAiDecision(null, [bomb], hand, last, false, 2, context, undefined, null), bomb);
  context.players[1].finishRank = 1;
  assert.equal(finalizeAiDecision(null, [bomb], hand, last, false, 2, context, undefined, null), null);
});
