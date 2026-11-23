import type { PlayerInfo } from '../sharedTypes';

// Local vector avatars stay sharp on phones and work without an image service.
export const AVATAR_LIBRARY = [
  { id: 'human-blue', kind: 'human', label: '蓝色牌友', background: '#d9efff', ink: '#326bac', accent: '#83bdf3' },
  { id: 'human-jade', kind: 'human', label: '青色牌友', background: '#d9f5e8', ink: '#287862', accent: '#7dcdb1' },
  { id: 'human-amber', kind: 'human', label: '金色牌友', background: '#fff1d3', ink: '#9b6632', accent: '#e9b96b' },
  { id: 'human-violet', kind: 'human', label: '紫色牌友', background: '#eee5ff', ink: '#7052a1', accent: '#b8a0e2' },
  { id: 'ai-mint', kind: 'ai', label: '薄荷机器人', background: '#d6f6ee', ink: '#236c64', accent: '#55c9ad' },
  { id: 'ai-coral', kind: 'ai', label: '珊瑚机器人', background: '#ffe3db', ink: '#a24842', accent: '#ed9580' },
  { id: 'ai-sky', kind: 'ai', label: '天空机器人', background: '#dceeff', ink: '#366b9a', accent: '#7db9ed' },
  { id: 'ai-gold', kind: 'ai', label: '暖金机器人', background: '#fff0cb', ink: '#886028', accent: '#e2b454' },
] as const;

export default function PlayerAvatar({ player }: { player: PlayerInfo }) {
  const kind = player.isAI ? 'ai' : 'human';
  const avatar = AVATAR_LIBRARY.find(item => item.id === player.avatarId)
    ?? AVATAR_LIBRARY.find(item => item.kind === kind)!;
  const isAI = avatar.kind === 'ai';

  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" role="img"
      aria-label={avatar.label} style={{ display: 'block', borderRadius: 'inherit' }}>
      <rect width="64" height="64" rx="14" fill={avatar.background} />
      {isAI ? (
        <>
          <path d="M32 10v8" stroke={avatar.ink} strokeWidth="3" />
          <circle cx="32" cy="9" r="4" fill={avatar.accent} />
          <rect x="7" y="29" width="8" height="15" rx="4" fill={avatar.accent} />
          <rect x="49" y="29" width="8" height="15" rx="4" fill={avatar.accent} />
          <rect x="13" y="19" width="38" height="34" rx="12" fill={avatar.ink} />
          <rect x="18" y="24" width="28" height="19" rx="7" fill="#f5fffb" />
          <circle cx="25" cy="33" r="3" fill={avatar.ink} />
          <circle cx="39" cy="33" r="3" fill={avatar.ink} />
          <path d="M27 47h10" stroke={avatar.accent} strokeWidth="3" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path d="M9 64v-5c0-12 10-19 23-19s23 7 23 19v5" fill={avatar.ink} />
          <path d="m24 43 8 9 8-9" fill={avatar.accent} />
          <rect x="27" y="34" width="10" height="13" rx="4" fill="#f2c8a5" />
          <ellipse cx="32" cy="27" rx="14" ry="16" fill="#ffdcba" />
          <path d="M18 29C11 7 42 2 46 21v9l-6-12c-5 6-14 6-22 7" fill={avatar.ink} />
          <circle cx="27" cy="28" r="1.6" fill={avatar.ink} />
          <circle cx="37" cy="28" r="1.6" fill={avatar.ink} />
          <path d="M28 35q4 4 8 0" fill="none" stroke={avatar.ink} strokeWidth="2" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
