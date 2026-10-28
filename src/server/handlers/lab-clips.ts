import { listPreppedClips } from '@/lib/clips';

export async function GET(): Promise<Response> {
  let spentTotal = 0;
  let concepts: string[] = [];
  let budgetUSD = 150;
  try {
    // Dynamic import: keyed modules throw at load when MODEL_API_KEY is unset.
    const sam = await import('@/lib/sam');
    spentTotal = sam.getSpend();
    concepts = [...sam.CONCEPTS];
    budgetUSD = sam.LAB_BUDGET_USD;
  } catch {
    spentTotal = 0;
  }
  return Response.json({ clips: listPreppedClips(), spentTotal, concepts, budgetUSD });
}
