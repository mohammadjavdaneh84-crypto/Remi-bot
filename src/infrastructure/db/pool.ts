import { Pool } from 'pg';
export function createPool(connectionString: string, max = 5): Pool {
  return new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    options: '-c timezone=UTC',
  });
}
