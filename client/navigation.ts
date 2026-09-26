const SCREENS = ['name', 'home', 'play', 'garage', 'help', 'settings', 'lobby'] as const;
export type Screen = (typeof SCREENS)[number];
export type Modal = '' | 'menu' | 'leave' | 'help';
export function isScreen(value: string): value is Screen {
  return SCREENS.some((screen) => screen === value);
}
