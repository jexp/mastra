import { Database } from '@neo4j-labs/cypherlite';
import { describe, expect, it } from 'vitest';

import { CYPHERLITE_PACKAGE_NAME } from './index';

describe('@mastra/cypherlite scaffold', () => {
  it('exposes the package name', () => {
    expect(CYPHERLITE_PACKAGE_NAME).toBe('@mastra/cypherlite');
  });

  it('loads the native CypherLite library and runs a query', () => {
    const db = Database.open(':memory:');
    const connection = db.connect();

    expect(connection.query('RETURN 1 AS n').single().n).toBe(1);
  });
});
