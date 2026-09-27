/**
 * Delete specific user accounts, completely: their resume files in S3, every
 * session, and all their rows (resumes, claims, plans, interviews, turns,
 * evidence, reports — all onDelete: Cascade).
 *
 * Targets ONLY the emails you name. (The old version deleted everyone EXCEPT the
 * named emails, which made a typo catastrophic, and it left files in S3.)
 *
 * Dry run by default — shows exactly what would go. Add --yes to delete.
 *
 *   npm run users:delete -- --email a@x.com --email b@x.com          # preview
 *   npm run users:delete -- --email a@x.com --email b@x.com --yes    # delete
 *
 * Usage history (usage_events) is kept on purpose — spend stays on the books.
 */
import { prisma } from '@/db/prisma';
import { redis } from '@/db/redis';
import { deleteObject } from '@/storage/s3';
import { refreshStore } from '@/auth/refresh-store';

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes('--yes');
  const emails = args
    .flatMap((a, i) => (a === '--email' && args[i + 1] ? [args[i + 1]!.trim().toLowerCase()] : []))
    .filter(Boolean);

  if (emails.length === 0) {
    console.log('Name at least one account:  npm run users:delete -- --email someone@x.com');
    process.exitCode = 1;
    return;
  }

  const users = await prisma.user.findMany({
    where: { email: { in: emails, mode: 'insensitive' } },
    select: {
      id: true,
      email: true,
      resumes: { select: { fileUrl: true } },
      _count: { select: { interviews: true, blueprints: true } },
    },
  });

  const found = new Set(users.map((u) => u.email.toLowerCase()));
  const missing = emails.filter((e) => !found.has(e));

  console.log(`\nAccounts to delete: ${users.length}`);
  for (const u of users) {
    console.log(
      `  - ${u.email}  ·  ${u.resumes.length} resume file(s), ${u._count.blueprints} plan(s), ${u._count.interviews} interview(s)`,
    );
  }
  if (missing.length) console.log(`\nNo account found for: ${missing.join(', ')}`);

  if (users.length === 0) return;

  if (!confirm) {
    console.log('\nDRY RUN — nothing deleted. Re-run with --yes to delete these accounts.\n');
    return;
  }

  for (const u of users) {
    // Files first: once the rows are gone we no longer know which objects were theirs.
    const purged = await Promise.allSettled(u.resumes.map((r) => deleteObject(r.fileUrl)));
    const failed = purged.filter((p) => p.status === 'rejected').length;

    await refreshStore.removeAll(u.id);
    await prisma.user.delete({ where: { id: u.id } });

    console.log(
      `✅ ${u.email} deleted — ${u.resumes.length - failed}/${u.resumes.length} files purged${failed ? ' (⚠️ some files failed to purge)' : ''}`,
    );
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error('Failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });
