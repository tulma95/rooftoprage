import { validEquipment, validInput, type ClientMessages, type ServerMessages } from './game.js';

type PayloadArgs<T> = T extends undefined ? [payload?: T] : [payload: T];
interface Sender {
  send(type: string, payload?: unknown): void;
}

export function sendClientMessage<K extends keyof ClientMessages>(
  room: Sender | null,
  type: K,
  ...args: PayloadArgs<ClientMessages[K]>
): void {
  room?.send(type, args[0]);
}

export function sendServerMessage<K extends keyof ServerMessages>(
  client: Sender,
  type: K,
  payload: ServerMessages[K],
): void {
  client.send(type, payload);
}

export const clientMessageValidators: {
  [K in keyof ClientMessages]: (value: unknown) => value is ClientMessages[K];
} = {
  sync: (value): value is undefined => value === undefined,
  input: validInput,
  equipment: validEquipment,
  ready: (value): value is boolean => typeof value === 'boolean',
  start: (value): value is undefined => value === undefined,
  loaded: (value): value is undefined => value === undefined,
  again: (value): value is undefined => value === undefined,
};
