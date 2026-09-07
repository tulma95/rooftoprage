import {
  validName,
  validEquipment,
  type Chassis,
  type FrontWeapon,
  type TopWeapon,
} from '../shared/game.js';

export interface Settings {
  audio: boolean;
  music: boolean;
  shake: boolean;
  contrast: boolean;
}
export interface Profile {
  nickname: string;
  chassis: Chassis;
  front: FrontWeapon;
  top: TopWeapon;
  settings: Settings;
}
export function loadProfile(): Profile {
  const profile: Profile = {
    nickname: '',
    chassis: 'mule',
    front: 'ram',
    top: 'cannon',
    settings: { audio: true, music: true, shake: true, contrast: false },
  };
  try {
    const saved = JSON.parse(localStorage.getItem('rooftop-profile') || '{}');
    if (validName(saved.nickname)) profile.nickname = saved.nickname;
    if (validEquipment(saved)) {
      profile.front = saved.front;
      profile.top = saved.top;
      profile.chassis = saved.chassis ?? 'mule';
    }
    for (const key of Object.keys(profile.settings) as (keyof Settings)[])
      if (typeof saved.settings?.[key] === 'boolean') profile.settings[key] = saved.settings[key];
  } catch {
    /* Storage is optional. */
  }
  return profile;
}
export function saveProfile(profile: Profile): boolean {
  try {
    localStorage.setItem('rooftop-profile', JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}
