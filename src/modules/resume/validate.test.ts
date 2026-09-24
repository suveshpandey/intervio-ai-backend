import { describe, it, expect } from 'vitest';
import { looksLikeResume, extractionIsEmpty } from '@/modules/resume/validate';

const REAL_RESUME = `RAHUL SHARMA
Bengaluru · rahul@example.com · github.com/rahulsharma

SUMMARY
Backend engineer with three years building payment and reporting systems in Node and Postgres.

EXPERIENCE
Zentrix Technologies — Software Engineer (2023–present)
- Cut p95 latency on the reporting API from 820ms to 190ms with a composite index and a Redis cache.
- Migrated the billing service from a monolith to three services with zero downtime.
- Mentored two interns and ran weekly code reviews for a team of six.

Kalvi Labs — Junior Developer (2021–2023)
- Rebuilt the student dashboard in React and cut the initial bundle from 1.4MB to 480KB.
- Wrote the payments integration with Razorpay.

PROJECTS
KiteWatch — real-time stock alerts, WebSocket fan-out to 2000 concurrent clients.

SKILLS
TypeScript, Node.js, React, Postgres, Redis, AWS, Docker, Kafka

EDUCATION
B.Tech Computer Science, VIT Vellore, 2021`;

describe('looksLikeResume', () => {
  it('accepts a normal resume', () => {
    expect(looksLikeResume(REAL_RESUME)).toEqual({ ok: true });
  });

  it('rejects an empty or unreadable file with advice about scans', () => {
    const result = looksLikeResume('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('scan');
  });

  it('rejects keyboard mash', () => {
    expect(looksLikeResume('asdkjfhaskdjfhaskjdfhaksjdhfkajshdf '.repeat(40)).ok).toBe(false);
  });

  it('rejects a long document that is not a resume', () => {
    const menu = `TRATTORIA MENU
      Margherita pizza with san marzano tomato, fior di latte and basil, baked in a wood oven.
      Carbonara made with guanciale, pecorino romano, black pepper and egg yolk.
      Tiramisu with mascarpone, savoiardi and espresso. Affogato with vanilla gelato.
      Negroni, Aperol spritz, house red, house white, sparkling water, still water.
      Open every evening from six until eleven. Bookings by telephone only.
      `.repeat(4);
    expect(looksLikeResume(menu).ok).toBe(false);
  });

  it('rejects one repeated line, however long', () => {
    expect(looksLikeResume('hello world '.repeat(500)).ok).toBe(false);
  });

  it('rejects symbol soup / binary-looking text', () => {
    expect(looksLikeResume('§¶∆˚¬≈ç√∫˜µ≤≥÷'.repeat(200)).ok).toBe(false);
  });

  it('rejects a short note even when it mentions a job', () => {
    expect(looksLikeResume('Hi, I am a developer with experience in Node. Please interview me.').ok).toBe(false);
  });

  it("keeps a resume that happens to be plain, with no fancy sections", () => {
    const plain = `ANITA DESAI
      Software developer, Pune. anita@example.com

      Worked at Northstar Systems since 2022 as a backend engineer building internal tools in Python
      and Django, with Postgres for storage and Celery for background jobs. Before that I studied
      computer science at Pune University and finished my bachelor degree in 2022. My projects
      include a library catalogue used by three colleges, an attendance tracker, and a small
      scheduling service written in Go. Skills include Python, Django, Postgres, Celery, Docker,
      Linux administration, basic Kubernetes, and writing automated tests with pytest.`;
    expect(looksLikeResume(plain)).toEqual({ ok: true });
  });
});

describe('extractionIsEmpty', () => {
  it('is empty only when nothing resume-shaped came back', () => {
    expect(extractionIsEmpty({ skills: [], projects: [], experience: [] })).toBe(true);
    expect(extractionIsEmpty({ skills: ['node'], projects: [], experience: [] })).toBe(false);
    expect(extractionIsEmpty({ skills: [], projects: [], experience: [{}] })).toBe(false);
  });
});
