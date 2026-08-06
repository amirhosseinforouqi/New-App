/**
 * Run a skill on demand.
 *
 * The broker's manual entry point into the agent layer. Also the endpoint your
 * own skills become reachable through the moment they are registered — there
 * is nothing to change here to add one.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getSkill, listSkills, runSkillNow } from '@/lib/agent';
import { getCurrentUser } from '@/lib/auth/session';

const bodySchema = z.object({
  skillKey: z.string().min(1),
  clientId: z.string().uuid().nullable().default(null),
  input: z.record(z.unknown()).default({}),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'broker') {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 403 });
  }

  return NextResponse.json({
    skills: listSkills().map((skill) => ({
      key: skill.key,
      title: skill.title,
      description: skill.description,
      triggers: skill.triggers,
    })),
  });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'broker') {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const { skillKey, clientId, input } = parsed.data;

  if (!getSkill(skillKey)) {
    return NextResponse.json({ error: `No skill registered as "${skillKey}".` }, { status: 404 });
  }

  // Runs synchronously so the broker sees the result immediately. The queued
  // path exists for automatic triggers, where nobody is waiting on a response.
  const { runId, result } = await runSkillNow(clientId, skillKey, 'manual', {
    ...input,
    ...(clientId ? { clientId } : {}),
  });

  if (result.status === 'failed') {
    return NextResponse.json({ runId, error: result.error }, { status: 500 });
  }

  return NextResponse.json({ runId, output: result.output });
}
