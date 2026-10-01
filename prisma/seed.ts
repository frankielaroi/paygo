import 'dotenv/config';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { StaffRole } from '../src/generated/prisma/enums';

/**
 * Creates the first admin, which is the only way to get into a fresh deployment. Idempotent
 * on email, and it never overwrites an existing user's password: re-running the seed against
 * an environment where someone has changed their password must not reset it.
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  const email = process.env.SEED_ADMIN_EMAIL?.toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  if (!email || !password) {
    throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required');
  }

  if (password.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    const existing = await prisma.user.findUnique({ where: { email } });

    if (existing) {
      console.log(`Admin ${email} already exists, leaving it untouched.`);
      return;
    }

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password, {
          type: argon2.argon2id,
          memoryCost: 19456,
          timeCost: 2,
          parallelism: 1,
        }),
        firstName: 'Platform',
        lastName: 'Admin',
        role: StaffRole.ADMIN,
      },
    });

    console.log(`Created admin ${user.email} (${user.id}).`);
    console.log(
      'Change this password before anyone else uses the environment.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
