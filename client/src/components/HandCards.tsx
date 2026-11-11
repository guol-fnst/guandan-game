import React, { useRef, useState } from 'react';
import { Card, Rank, Suit } from '../sharedTypes';
import CardComponent from './CardComponent';

interface Props {
  cards: Card[];
  selectedIds: Set<number>;
  onToggle: (id: number) => void;
  onToggleStack: (ids: number[]) => void;
  currentLevel: number;
  /** Portrait phones group jokers, level cards, then the four suits. */
  groupBySuit?: boolean;
}

function stackOffset(index: number) {
  if (index === 0) return '0px';
  return `calc(${Array.from({ length: index }, () => 'var(--hand-stack-rise)').join(' + ')})`;
}

export default function HandCards({ cards, selectedIds, onToggle, onToggleStack, currentLevel, groupBySuit = false }: Props) {
  const gesture = useRef<{
    pointerId: number; x: number; y: number; select: boolean;
    selected: Set<number>; visited: Set<number>;
    targets: { id: number; bounds: DOMRect; order: number }[];
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const suppressPointerClick = useRef(false);

  const visitPoint = (x: number, y: number) => {
    const active = gesture.current;
    if (!active) return;
    const target = active.targets.find(({ bounds }) => x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom);
    if (!target || active.visited.has(target.id)) return;
    active.visited.add(target.id);
    if (active.selected.has(target.id) !== active.select) onToggle(target.id);
  };
  const startGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressPointerClick.current = false;
    // Portrait hands can scroll horizontally; preserve native panning there.
    if (event.pointerType !== 'mouse' && !window.matchMedia('(orientation: landscape)').matches) return;
    const slot = (event.target as HTMLElement).closest<HTMLElement>('[data-card-id]');
    if (!slot) return;
    const id = Number(slot.dataset.cardId);
    // Freeze hit areas before selection lifts the cards, so a swipe cannot
    // accidentally hit a newly exposed card underneath the original target.
    const targets = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-card-id]')].map(element => ({
      id: Number(element.dataset.cardId),
      order: Number(element.dataset.hitOrder),
      bounds: element.querySelector('.playing-card')!.getBoundingClientRect(),
    })).sort((a, b) => b.order - a.order);
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, select: !selectedIds.has(id), selected: new Set(selectedIds), visited: new Set(), targets };
    suppressPointerClick.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    visitPoint(event.clientX, event.clientY);
    event.preventDefault();
  };
  const moveGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    // Sample the complete path, including when a fast swipe skips columns.
    const steps = Math.max(1, Math.ceil(Math.hypot(event.clientX - active.x, event.clientY - active.y) / 4));
    for (let step = 1; step <= steps; step++) visitPoint(active.x + (event.clientX - active.x) * step / steps, active.y + (event.clientY - active.y) * step / steps);
    active.x = event.clientX; active.y = event.clientY;
  };
  const finishGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  if (cards.length === 0) return null;

  const groupKey = (card: Card) => {
    if (groupBySuit && (card.rank === Rank.BigJoker || card.rank === Rank.SmallJoker)) return 'jokers';
    if (groupBySuit && card.rank === currentLevel) return 'level';
    if (card.rank === Rank.BigJoker || card.rank === Rank.SmallJoker) return `joker-${card.rank}`;
    return groupBySuit ? `suit-${card.suit}` : `rank-${card.rank}`;
  };
  const suitOrder: Record<Suit, number> = {
    [Suit.Spade]: 4,
    [Suit.Heart]: 3,
    [Suit.Club]: 2,
    [Suit.Diamond]: 1,
  };
  const displayedCards = groupBySuit
    ? [...cards].sort((a, b) => {
      const groupOrder = (card: Card) => {
        if (card.rank === Rank.BigJoker || card.rank === Rank.SmallJoker) return 6;
        if (card.rank === currentLevel) return 5;
        return suitOrder[card.suit];
      };
      const orderDiff = groupOrder(b) - groupOrder(a);
      if (orderDiff) return orderDiff;
      const bothJokers = [a, b].every(card => card.rank === Rank.BigJoker || card.rank === Rank.SmallJoker);
      if (bothJokers) return b.rank - a.rank || b.id - a.id;
      return suitOrder[b.suit] - suitOrder[a.suit] || b.rank - a.rank || b.id - a.id;
    })
    : cards;

  const groups: Card[][] = [];
  for (const card of displayedCards) {
    const last = groups[groups.length - 1];
    if (!last || groupKey(last[0]) !== groupKey(card)) groups.push([card]);
    else last.push(card);
  }

  const maxStack = Math.max(...groups.map(group => group.length));
  // Compress only the overlap distance when one suit is unusually large, so
  // the complete portrait hand remains visible.
  const compactStackRise = Math.max(2, Math.min(10, Math.floor(68 / Math.max(1, maxStack - 1))));
  const stackHeight = maxStack > 1
    ? `calc(var(--hand-card-height) + ${Array.from({ length: maxStack - 1 }, () => 'var(--hand-stack-rise)').join(' + ')})`
    : 'var(--hand-card-height)';

  return (
    <div
      className={`hand-cards${dragging ? ' is-dragging' : ''}`}
      onPointerDown={startGesture}
      onPointerMove={moveGesture}
      onPointerUp={event => { moveGesture(event); finishGesture(event); }}
      onPointerCancel={finishGesture}
      onLostPointerCapture={finishGesture}
      onClickCapture={event => { if (suppressPointerClick.current && event.detail > 0) { event.preventDefault(); event.stopPropagation(); suppressPointerClick.current = false; } }}
      style={{
        height: stackHeight,
        '--hand-group-count': groups.length,
        '--hand-stack-count': Math.max(1, maxStack - 1),
        ...(groupBySuit ? { '--hand-stack-rise': `${compactStackRise}px` } : {}),
      } as React.CSSProperties}
      aria-label={`手牌，共 ${cards.length} 张`}
    >
      {groups.map((group, groupIndex) => (
        <div
          className="hand-card-group"
          key={`${groupKey(group[0])}-${groupIndex}`}
          style={{
            zIndex: groupIndex + 1,
            flexBasis: groupIndex === groups.length - 1
              ? 'var(--hand-card-width)'
              : 'var(--hand-column-step)',
            minWidth: groupIndex === groups.length - 1
              ? 'var(--hand-card-width)'
              : 'var(--hand-column-min)',
          }}
        >
          {group.map((card, cardIndex) => {
            const selected = selectedIds.has(card.id);
            return (
              <div
                className={`hand-card-slot${cardIndex > 0 ? ' is-stacked' : ''}`}
                key={card.id}
                data-card-id={card.id}
                data-hit-order={groupIndex * 100 + group.length - cardIndex}
                style={{
                  bottom: stackOffset(cardIndex),
                  // Keep a selected card inside its original stack layer. Raising its
                  // wrapper above the entire stack hides the middle cards in 3+ stacks.
                  zIndex: group.length - cardIndex,
                }}
              >
                <CardComponent
                  card={card}
                  selected={selected}
                  onClick={() => onToggle(card.id)}
                  onContextMenu={() => onToggleStack(group.map(({ id }) => id))}
                  isLevelCard={card.rank === currentLevel}
                  size="hand"
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
