import type { Request, Response } from 'express';
import type { Blueprint } from '@prisma/client';
import { prisma } from '@/db/prisma';
import { notFound } from '@/common/errors';
import { param } from '@/common/http';
import { blueprintConfigSchema } from '@/modules/planner/schema';
import { blueprintRepository } from '@/modules/planner/blueprint.repository';
import { buildBlueprint } from '@/modules/planner/planner.service';

/** Blueprint + its probed claims expanded (in probe order) for the preview screen. */
async function withClaims(blueprint: Blueprint) {
  const claims = await prisma.claim.findMany({ where: { id: { in: blueprint.probeClaimIds } } });
  const byId = new Map(claims.map((c) => [c.id, c]));
  const probedClaims = blueprint.probeClaimIds.map((id) => byId.get(id)).filter(Boolean);
  return { blueprint, probedClaims };
}

export const plannerController = {
  async create(req: Request, res: Response) {
    const config = blueprintConfigSchema.parse(req.body);
    const blueprint = await buildBlueprint(req.userId!, config);
    res.status(201).json(await withClaims(blueprint));
  },

  async detail(req: Request, res: Response) {
    const blueprint = await blueprintRepository.findById(param(req, 'id'), req.userId!);
    if (!blueprint) throw notFound('Blueprint not found');
    res.json(await withClaims(blueprint));
  },
};
