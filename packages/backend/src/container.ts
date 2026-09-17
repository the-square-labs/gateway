import 'reflect-metadata';
import { container } from 'tsyringe';

export const TOKENS = {
  DrizzleClient: Symbol('DrizzleClient'),
  RedisClient: Symbol('RedisClient'),
  Env: Symbol('Env'),
  CommercialEdition: Symbol('CommercialEdition'),
} as const;

export { container };

export function resolve<T>(token: symbol): T {
  return container.resolve<T>(token);
}
