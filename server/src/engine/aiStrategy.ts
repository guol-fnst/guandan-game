import { Card, Rank, Suit } from '../../../shared/types';
import type { AiDecisionContext } from './llmAi';

/** Synthesized guidance, not a learned policy or a reproduction of paper results.
 * Sources and qualifications: docs/ai-strategy-research.md.
 * Stable checklist shared by every decision; no additional model requests. */
export const STRATEGY_GUIDE = `整手规划：先以本方名次和升级为目标，比较自己冲刺、接管送队友、让队友续走三条路线。自己牌弱不等于无用，可用控制牌换取队友的走牌机会；队友牌少也不自动等于可走完。
牌权预算：静态拆分手数不等于所需牌权。对每条路线问：先出什么，被压后用什么回手，回手后放出哪组尾牌；没有回手办法就说明风险，不臆造连续控权。
资源预算：王、A、自然级牌对子/三张、完整炸弹、同花顺、逢人配都是不同用途的控制资源。普通自然牌并不都便宜；比较足够压住当前牌的较弱完整组合。平静开局若顺子、低三带二等组合能以相同余牌手数整理至少同样多的牌，先保留三张A、级牌和王作为回手；若高组合能显著减少余牌手数或解决唯一坏结构，允许先出。附件不加强三带二主体；主体和附件一起比较，不能只换附件。配牌的价值是保留重组选择，也可用于消除多张难走尾牌，不能一概禁止早用。
行为推断：从公开领牌、接牌、过牌和余牌数提出对手/队友可能的结构及备选解释。过牌可能保牌或让队友，不证明没有该牌型；不假设两张必是对子、不把可能底牌当事实。
主动与让牌：判断谁正在连续减牌、谁可能下一手结束、PASS后谁领牌或接风。接管要能阻断威胁、改变不利牌型或释放续牌；让牌要有具体等待条件，不能笼统保牌。
配合与座次：送牌先确认自己保留了实际可出的续牌，再看队友前方的对手能否截住。可合理接管队友，但须有比让队友继续走更明确的团队收益；队友不共享你的私有计划。
最终比较：对最有区别的方案逐一比较本方收益、资源损失、余牌结构、回手可靠性及敌方最危险应对，再选action_id。模拟只提供不确定的证据；不能仅凭出牌张数、最少手数或最大牌作决定。直接走完、必要防守、可靠送牌可合理花费控制资源。`;

export function strategyBrief(hand: Card[], level: number, context?: AiDecisionContext) {
  const naturalLevel = hand.filter(c => c.rank === level && c.suit !== Suit.Heart).length;
  const opponents = context?.players.filter(p => p.relation === 'opponent' && p.finishRank === null) || [];
  return {
    framework_version: 'whole-hand-v1',
    level,
    natural_level_cards: naturalLevel,
    level_group_options: { pair: naturalLevel >= 2, triple: naturalLevel >= 3,
      caveat: '这些选择重叠，不是独立的多次控制；顺子按声明点数比较' },
    wildcards: hand.filter(c => c.rank === level && c.suit === Suit.Heart).length,
    most_advanced_opponents: opponents.length ? opponents.filter(p =>
      p.cardCount === Math.min(...opponents.map(x => x.cardCount))).map(p => p.seatIndex) : [],
    comparison_axes: ['team_finish_order', 'lead_and_recapture', 'control_resources',
      'remaining_structure', 'seat_interception', 'opponent_best_reply'],
    note: '推进快不证明牌强；牌少不证明牌型。按公开证据规划，不读取其他手牌。',
  };
}
