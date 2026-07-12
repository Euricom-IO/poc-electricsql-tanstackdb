import { eq } from 'drizzle-orm';
import { db } from './client';
import { users } from './schema';

const ADMIN_NAME = 'peter';
const ADMIN_PIN = '12345';

const existing = await db.select().from(users).where(eq(users.name, ADMIN_NAME));

if (existing.length === 0) {
  const pinHash = await Bun.password.hash(ADMIN_PIN);
  await db.insert(users).values({ name: ADMIN_NAME, pinHash, role: 'admin' });
  console.log(`✔ Seeded admin user (name: "${ADMIN_NAME}", pin: "${ADMIN_PIN}")`);
} else {
  console.log('✔ Admin user already exists, nothing to seed');
}

process.exit(0);
