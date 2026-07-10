import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

function requireStrongBootstrapPassword(value: string): string {
  const placeholder = /(replace|change[-_ ]?me|example|demo|default)/i.test(value);
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].every((pattern) => pattern.test(value));
  if (value.length < 20 || placeholder || !classes) {
    throw new Error('BOOTSTRAP_PLATFORM_ADMIN_PASSWORD must be at least 20 characters, non-placeholder, and contain upper/lowercase, number, and symbol');
  }
  return value;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_TEST_SEED !== 'true') {
    if (!process.env.BOOTSTRAP_PLATFORM_ADMIN_EMAIL || !process.env.BOOTSTRAP_PLATFORM_ADMIN_PASSWORD) {
      console.log('Production seed skipped: no demo merchant, key, or virtual fleet data was created.');
      return;
    }
    const email = process.env.BOOTSTRAP_PLATFORM_ADMIN_EMAIL.trim().toLocaleLowerCase('en-US');
    const passwordHash = await argon2.hash(requireStrongBootstrapPassword(process.env.BOOTSTRAP_PLATFORM_ADMIN_PASSWORD));
    const created = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('platform-admin-bootstrap'))`;
      const existingCount = await transaction.platformStaff.count();
      if (existingCount !== 0) {
        throw new Error('Production platform-admin bootstrap is create-once and was refused because a staff account already exists. Use the audited break-glass recovery procedure instead.');
      }
      const staff = await transaction.platformStaff.create({
        data: {
          email,
          displayName: process.env.BOOTSTRAP_PLATFORM_ADMIN_NAME ?? 'Platform Administrator',
          passwordHash,
          role: 'admin',
        },
      });
      await transaction.auditLog.create({
        data: {
          actorType: 'system',
          actorId: 'production-bootstrap',
          action: 'platform_staff.bootstrap_created',
          targetType: 'platform_staff',
          targetId: staff.id,
          reason: 'Initial create-once production administrator bootstrap',
        },
      });
      return staff;
    }, { isolationLevel: 'Serializable' });
    console.log(`Platform administrator created once: ${created.email}. Remove BOOTSTRAP_PLATFORM_ADMIN_PASSWORD from the deployment environment now; demo data was not created.`);
    return;
  }
  const merchant = await prisma.merchant.upsert({
    where: { slug: 'demo-merchant' },
    update: {},
    create: { slug: 'demo-merchant', name: 'Demo Merchant', config: { create: {} } },
  });

  const testKey = 'sk_test_demo.demo_secret_change_before_shared_use_2026';
  await prisma.apiKey.upsert({
    where: { prefix: 'sk_test_demo' },
    update: { secretHash: await argon2.hash(testKey), revokedAt: null },
    create: {
      merchantId: merchant.id,
      environment: 'test',
      label: 'Local integration test',
      prefix: 'sk_test_demo',
      secretHash: await argon2.hash(testKey),
    },
  });

  if (process.env.NODE_ENV !== 'production' || process.env.BOOTSTRAP_MERCHANT_OWNER_PASSWORD) {
    const ownerEmail = (process.env.BOOTSTRAP_MERCHANT_OWNER_EMAIL ?? 'owner@demo.local').toLocaleLowerCase('en-US');
    const ownerPassword = process.env.BOOTSTRAP_MERCHANT_OWNER_PASSWORD ?? 'Demo-merchant-password-2026!';
    await prisma.merchantUser.upsert({
      where: { merchantId_email: { merchantId: merchant.id, email: ownerEmail } },
      update: { passwordHash: await argon2.hash(ownerPassword), status: 'active', role: 'owner' },
      create: { merchantId: merchant.id, email: ownerEmail, displayName: 'Demo Merchant Owner', passwordHash: await argon2.hash(ownerPassword), role: 'owner' },
    });
    if (process.env.NODE_ENV !== 'production') console.log(`Demo portal owner: ${ownerEmail} / ${ownerPassword}`);
  }

  if (process.env.BOOTSTRAP_PLATFORM_ADMIN_EMAIL && process.env.BOOTSTRAP_PLATFORM_ADMIN_PASSWORD) {
    const email = process.env.BOOTSTRAP_PLATFORM_ADMIN_EMAIL.toLocaleLowerCase('en-US');
    const existing = await prisma.platformStaff.findUnique({ where: { email } });
    if (!existing) {
      await prisma.platformStaff.create({
        data: { email, displayName: process.env.BOOTSTRAP_PLATFORM_ADMIN_NAME ?? 'Platform Administrator', passwordHash: await argon2.hash(process.env.BOOTSTRAP_PLATFORM_ADMIN_PASSWORD), role: 'admin' },
      });
      console.log(`Development platform administrator created: ${email}`);
    } else {
      console.log(`Development platform administrator already exists; seed did not reset credentials: ${email}`);
    }
  }

  const location = await prisma.fleetLocation.upsert({
    where: { code: 'PILOT-ADDIS' },
    update: {},
    create: { code: 'PILOT-ADDIS', name: 'Addis Ababa pilot' },
  });
  const group = await prisma.deviceGroup.upsert({
    where: { code: 'PILOT-CH9N' },
    update: {},
    create: { code: 'PILOT-CH9N', name: 'TECNO CH9n pilot', locationId: location.id },
  });
  // The simulator is created lazily by test-mode requests in its reserved
  // TEST-SIMULATOR group. Never seed it into a production fleet group.
  void group;

  const accountDefinitions = [
    ['merchant_available', 'Merchant available', 'liability'],
    ['merchant_reserved', 'Merchant reserved', 'liability'],
    ['telebirr_custody', 'Telebirr custody', 'asset'],
    ['treasury_custody', 'Treasury Telebirr custody', 'asset'],
    ['provider_fees', 'Telebirr provider fees', 'expense'],
    ['platform_fees', 'Platform gateway fees', 'revenue'],
    ['unmatched_receipts', 'Unmatched receipt suspense', 'liability'],
  ] as const;
  const accounts = new Map<string, { id: string }>();
  for (const [code, name, type] of accountDefinitions) {
    const account = await prisma.ledgerAccount.upsert({
      where: { merchantId_environment_code: { merchantId: merchant.id, environment: 'test', code } },
      update: {},
      create: { merchantId: merchant.id, environment: 'test', code, name, type },
    });
    accounts.set(code, account);
  }
  const seedSourceId = '00000000-0000-4000-8000-000000000001';
  const existingJournal = await prisma.ledgerJournal.findUnique({ where: { sourceType_sourceId: { sourceType: 'seed_funding', sourceId: seedSourceId } } });
  if (!existingJournal) {
    const amount = 1000000000n;
    await prisma.$transaction(async (transaction) => {
      const journal = await transaction.ledgerJournal.create({
        data: { environment: 'test', sourceType: 'seed_funding', sourceId: seedSourceId, description: 'Demo test-mode funding' },
      });
      await transaction.ledgerEntry.createMany({
        data: [
          { journalId: journal.id, accountId: accounts.get('telebirr_custody')!.id, direction: 'D', amountMinor: amount },
          { journalId: journal.id, accountId: accounts.get('merchant_available')!.id, direction: 'C', amountMinor: amount },
        ],
      });
      await transaction.ledgerAccount.update({ where: { id: accounts.get('telebirr_custody')!.id }, data: { balanceMinor: { increment: amount } } });
      await transaction.ledgerAccount.update({ where: { id: accounts.get('merchant_available')!.id }, data: { balanceMinor: { increment: amount } } });
    });
  }

  console.log(`Demo merchant: ${merchant.id}`);
  console.log(`Test key (local only): ${testKey}`);
}

main()
  .finally(async () => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
