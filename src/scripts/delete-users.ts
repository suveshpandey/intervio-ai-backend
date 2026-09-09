/**
 * Delete all users EXCEPT the ones you keep. Cascades to their resumes, JDs,
 * claims, blueprints, interviews, turns, and evidence (all onDelete: Cascade).
 *
 * Dry-run by default (lists what would be deleted). Pass --yes to actually delete.
 *
 *   npm run users:delete                       # dry run, keeps the default
 *   npm run users:delete -- --yes              # delete for real
 *   npm run users:delete -- --keep a@x.com --keep b@x.com --yes
 */
import { prisma } from '@/db/prisma';

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes('--yes');

  // Emails to KEEP (case-insensitive). Defaults to the one the user asked to preserve.
  const keep = args.reduce<string[]>((acc, a, i) => {
    const next = args[i + 1];
    if (a === '--keep' && next) acc.push(next.toLowerCase());
    return acc;
  }, []);
  if (keep.length === 0) keep.push('suvesh1@gmail.com');

  const doomed = await prisma.user.findMany({
    where: { email: { notIn: keep } },
    select: { id: true, email: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\nKeeping: ${keep.join(', ')}`);
  console.log(`Users to delete: ${doomed.length}`);
  for (const u of doomed) console.log(`  - ${u.email}  (${u.id})`);

  if (doomed.length === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  if (!confirm) {
    console.log('\nDRY RUN — no changes made. Re-run with --yes to delete these users.\n');
    return;
  }

  const { count } = await prisma.user.deleteMany({ where: { email: { notIn: keep } } });
  console.log(`\n✅ Deleted ${count} user(s) and all their related data (cascade).\n`);
}

main()
  .catch((err) => {
    console.error('Failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
