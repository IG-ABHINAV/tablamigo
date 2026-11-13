import postgres from 'postgres';
import { config } from './config.js';

export const sql = postgres(config.databaseUrl, {
  max: 10,
  transform: postgres.camel,       // snake_case columns -> camelCase fields
  // int8 (message ids) stays a string: BigInt can't be JSON-serialised by Fastify or socket.io.
  // date (trips, birthdates) stays 'YYYY-MM-DD': as a JS Date it becomes local midnight, which
  // serialises as the previous day in UTC on a UTC+ server.
  types: { date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } },
});
